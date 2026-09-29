/**
 * Transport-agnostic ingestion (docs/backend.md). HTTPS and MQTT adapters both call process().
 * Per message, in ONE transaction: validate → authorise robot → store-once (msg_id) → bump
 * last-seen → route by type → pg_notify (delivered on commit).
 */
import { isPgError, withTransaction, type Db } from '../db';
import {
  INGEST_MAX_FUTURE_SKEW_MS,
  INGEST_MIN_VALID_TS,
  parseRobotMessage,
  type RobotMessage,
} from '../shared';
import type { PoolClient } from 'pg';
import type { IngestClient } from './auth';
import { handleEvent } from './handlers/event';
import { handleHello } from './handlers/hello';
import { handleLive } from './handlers/live';
import { handleMission, MissionConflictError } from './handlers/mission';
import { handleTelemetry } from './handlers/telemetry';
import { notifyChange } from './notify';

export type IngestStatus = 'stored' | 'duplicate' | 'rejected';
export interface IngestResult {
  msg_id: string | null;
  status: IngestStatus;
  error?: string;
  /** false = do not retry; the robot should log it and drop it (the PMS kept a copy in ingest_rejections). */
  retryable?: boolean;
  details?: unknown;
}

class Rejection extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const MIN_TS = Date.parse(INGEST_MIN_VALID_TS);

/** Every ts in a message (envelope + telemetry samples) must be plausible, see constants.ts. */
function checkTimestamps(msg: RobotMessage, now: number): void {
  const all: string[] = [msg.ts];
  if (msg.type === 'telemetry') {
    const p = msg.payload;
    for (const arr of [p.gps, p.encoders, p.battery, p.health]) for (const s of arr ?? []) all.push(s.ts);
  }
  for (const ts of all) {
    const t = Date.parse(ts);
    if (t > now + INGEST_MAX_FUTURE_SKEW_MS) throw new Rejection('clock_ahead', `ts ${ts} is in the future; fix the robot/GCS clock (NTP)`);
    if (t < MIN_TS) throw new Rejection('clock_unsynced', `ts ${ts} is before ${INGEST_MIN_VALID_TS}; clock not synced (no RTC?)`);
  }
}

export class IngestPipeline {
  constructor(
    private readonly db: Db,
    private readonly log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
  ) {}

  /** Processes messages strictly in the given order (backlog is sent oldest first). */
  async processBatch(raws: unknown[], client: IngestClient, transport: 'https' | 'mqtt'): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    for (const raw of raws) results.push(await this.process(raw, client, transport));
    return results;
  }

  async process(raw: unknown, client: IngestClient, transport: 'https' | 'mqtt'): Promise<IngestResult> {
    const parsed = parseRobotMessage(raw);
    if (!parsed.ok) {
      return this.reject(raw, client, parsed.msg_id ?? null, parsed.error, 'message failed validation', parsed.details);
    }
    const msg = parsed.message;
    try {
      checkTimestamps(msg, Date.now());
      if (!client.robotIds.has(msg.robot_id)) {
        throw new Rejection('robot_not_allowed', `this key may not send data for ${msg.robot_id}`);
      }
      const status = await withTransaction(this.db, (tx) => this.store(tx, msg, raw, client, transport));
      return { msg_id: msg.msg_id, status };
    } catch (err) {
      if (err instanceof Rejection) return this.reject(raw, client, msg.msg_id, err.code, err.message, err.details);
      if (err instanceof MissionConflictError) return this.reject(raw, client, msg.msg_id, err.code, err.message);
      if (isPgError(err) && ['23514', '23503', '22P02', '22003', '22007', '22008'].includes(err.code)) {
        // data that passed the schema but violates a DB constraint: permanent, not retryable
        return this.reject(raw, client, msg.msg_id, 'constraint_violation', err.message);
      }
      this.log.error({ err, msg_id: msg.msg_id }, 'ingest failed');
      // transient (DB down …): robot keeps the message and retries later
      return { msg_id: msg.msg_id, status: 'rejected', error: 'internal_error', retryable: true };
    }
  }

  private async store(tx: PoolClient, msg: RobotMessage, raw: unknown, client: IngestClient, transport: 'https' | 'mqtt'): Promise<IngestStatus> {
    const robot = (
      await tx.query<{ product_code: string; deleted_at: Date | null }>(
        `SELECT p.code AS product_code, r.deleted_at FROM robots r JOIN products p ON p.id = r.product_id WHERE r.robot_id = $1`,
        [msg.robot_id],
      )
    ).rows[0];
    if (!robot) throw new Rejection('unknown_robot', `robot ${msg.robot_id} is not registered`);
    if (robot.deleted_at) throw new Rejection('robot_deleted', `robot ${msg.robot_id} is deleted`);
    if (robot.product_code !== msg.product) {
      throw new Rejection('product_mismatch', `robot ${msg.robot_id} is a ${robot.product_code}, message says ${msg.product}`);
    }

    // Rule 6: store exactly once.
    const inserted = await tx.query(
      `INSERT INTO ingested_messages (msg_id, robot_id, type, v, ts, client_id, transport, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (msg_id) DO NOTHING`,
      [msg.msg_id, msg.robot_id, msg.type, msg.v, msg.ts, client.id, transport, JSON.stringify(raw)],
    );
    if (!inserted.rowCount) return 'duplicate';

    // Any message proves the robot is reachable now (status = computed from last_seen_at).
    await tx.query(
      `UPDATE live_state SET
         last_seen_at = now(),
         sw_ver = CASE WHEN last_msg_ts IS NULL OR $2 >= last_msg_ts THEN coalesce($3, sw_ver) ELSE sw_ver END,
         fw_ver = CASE WHEN last_msg_ts IS NULL OR $2 >= last_msg_ts THEN coalesce($4, fw_ver) ELSE fw_ver END,
         last_msg_ts = greatest(last_msg_ts, $2)
       WHERE robot_id = $1`,
      [msg.robot_id, msg.ts, msg.sw_ver ?? null, msg.fw_ver ?? null],
    );

    let liveReplaced = false;
    switch (msg.type) {
      case 'hello':
        await handleHello(tx, msg);
        break;
      case 'live':
        liveReplaced = await handleLive(tx, msg);
        break;
      case 'telemetry':
        await handleTelemetry(tx, msg);
        break;
      case 'event':
        await handleEvent(tx, msg);
        break;
      case 'mission':
        await handleMission(tx, msg);
        break;
    }
    if (!liveReplaced) await notifyChange(tx, { kind: 'seen', robot_id: msg.robot_id });
    return 'stored';
  }

  private async reject(raw: unknown, client: IngestClient | null, msgId: string | null, code: string, message: string, details?: unknown): Promise<IngestResult> {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    try {
      await this.db.query(
        `INSERT INTO ingest_rejections (client_id, msg_id, robot_id, type, error, details, raw) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          client?.id ?? null,
          msgId,
          typeof r.robot_id === 'string' ? r.robot_id.slice(0, 200) : null,
          typeof r.type === 'string' ? r.type.slice(0, 50) : null,
          code,
          JSON.stringify({ message, details: details ?? null }),
          JSON.stringify(raw ?? null),
        ],
      );
    } catch (err) {
      this.log.warn({ err }, 'could not record ingest rejection');
    }
    return { msg_id: msgId, status: 'rejected', error: code, retryable: false, details: details ?? message };
  }
}

export { Rejection };
