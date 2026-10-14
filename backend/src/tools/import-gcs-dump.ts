/**
 * Imports a GCS database dump (pg_dump of the GCS's Django database, e.g. adani-trails/.../gcs_db_dump_*.sql.gz)
 * into one robot, in the same shape the robot's own fleet_sync sends: telemetry (GPS + battery), live status
 * every 30 s, and per mission report a mission `end` message plus the GCS report (waypoints, planned path).
 * Only what the client portal reports read; detections / environment events are not imported.
 *
 *   npm run import:gcs -- <dump.sql[.gz]> --robot saibya02 --from 2026-10-01 [--to 2026-10-11] [--dry-run]
 *
 * --from / --to are IST days (inclusive). Every message gets a msg_id derived from its source rows, and every
 * mission keeps the GCS report id as its mission_id (as fleet_sync does), so re-running never duplicates.
 * The robot's last-seen time is not touched (old data must not make it look online).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { PoolClient } from 'pg';
import { createPool, withTransaction } from '../db';
import { handleLive } from '../ingest/handlers/live';
import { handleMission, mergeGcsReport } from '../ingest/handlers/mission';
import { handleTelemetry } from '../ingest/handlers/telemetry';
import { gcsMissionReportSchema, parseRobotMessage, type RobotMessage } from '../shared';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FILE = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const ROBOT = opt('robot');
const DRY = args.includes('--dry-run');
const FROM = opt('from');
const TO = opt('to');
if (!FILE || !ROBOT || !FROM) {
  console.error('usage: npm run import:gcs -- <dump.sql[.gz]> --robot <robot_id> --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run]');
  process.exit(2);
}
const IST_MS = 5.5 * 3600_000;
const START = Date.parse(`${FROM}T00:00:00Z`) - IST_MS;
const END = TO ? Date.parse(`${TO}T00:00:00Z`) - IST_MS + 86_400_000 : Infinity;
const inRange = (t: number) => t >= START && t < END;

const TELEMETRY_CHUNK = 300; // GPS samples per telemetry message
const LIVE_EVERY_MS = 30_000; // the robot's live cadence
const BATTERY_EVERY_MS = 60_000;
const MAX_PATH_POINTS = 5000;
const SOURCE = `gcs-dump:${FILE.split(/[\\/]/).pop()}`;

// ── pg_dump COPY text format ────────────────────────────────────────────────

const TABLES = new Set(['public.apis_ugvtelemetry', 'public.apis_missionreport', 'public.apis_bot']);

function unescapeCopy(v: string): string | null {
  if (v === '\\N') return null;
  if (!v.includes('\\')) return v;
  return v.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' } as Record<string, string>)[e] ?? e;
  });
}

async function readTables(file: string): Promise<Map<string, Record<string, string | null>[]>> {
  const input = createReadStream(file);
  const lines = createInterface({ input: file.endsWith('.gz') ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
  const out = new Map<string, Record<string, string | null>[]>();
  let table: string | null = null;
  let cols: string[] = [];
  for await (const line of lines) {
    if (table) {
      if (line === '\\.') {
        table = null;
        continue;
      }
      const vals = line.split('\t');
      const row: Record<string, string | null> = {};
      cols.forEach((c, i) => (row[c] = unescapeCopy(vals[i] ?? '\\N')));
      out.get(table)!.push(row);
      continue;
    }
    const m = /^COPY (\S+) \((.+)\) FROM stdin;$/.exec(line);
    if (m && TABLES.has(m[1])) {
      table = m[1];
      cols = m[2].split(', ').map((c) => c.replace(/^"|"$/g, ''));
      out.set(table, []);
    }
  }
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Deterministic UUID (v5 layout) from a name: the same source rows always give the same msg_id. */
function uuidFrom(name: string): string {
  const b = createHash('sha1').update(`${SOURCE}|${name}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** "2026-10-05 16:30:00.897233+00" → epoch ms (Postgres text timestamps; microseconds dropped). */
function pgTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(:?\d{2})?$/.exec(v.trim());
  const t = m ? Date.parse(`${m[1]}T${m[2]}${(m[3] ?? '').slice(0, 4)}${m[4]}:${(m[5] ?? '00').replace(':', '')}`) : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const iso = (t: number) => new Date(t).toISOString();
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const json = <T>(v: string | null): T | null => {
  try {
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
/** GCS fix names (SINGLE, RTK_FIXED, NO_FIX …) → the portal's lower-case fix qualities. */
const fixOf = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  const f = v.trim().toLowerCase();
  return f === 'no_fix' || f === 'nofix' ? 'none' : f;
};
const validLatLon = (lat: number | undefined, lon: number | undefined): boolean =>
  lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
function thin<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const step = list.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(list[Math.floor(i * step)]);
  out[out.length - 1] = list[list.length - 1];
  return out;
}

// ── build messages ──────────────────────────────────────────────────────────

interface Sample {
  t: number;
  lat: number;
  lon: number;
  alt?: number;
  speed?: number;
  heading?: number;
  fix?: string;
  sats?: number;
  mode?: string;
  bms: { soc?: number; voltage?: number; current?: number; temp_max?: number; ts?: string } | null;
}

function envelope(type: RobotMessage['type'], ts: number, key: string, payload: unknown, product: string) {
  return { v: 1, msg_id: uuidFrom(`${type}:${key}`), robot_id: ROBOT!, product, ts: iso(ts), type, import_source: SOURCE, payload };
}

function telemetryMessages(rows: Record<string, string | null>[], product: string) {
  const samples: Sample[] = [];
  for (const r of rows) {
    const t = pgTime(r.timestamp);
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    if (t === null || !inRange(t) || !validLatLon(lat, lon)) continue;
    const ex = json<Record<string, unknown>>(r.extras) ?? {};
    samples.push({
      t,
      lat: lat!,
      lon: lon!,
      alt: num(r.altitude),
      speed: num(r.speed),
      heading: num(r.imu_yaw),
      fix: fixOf(ex.gps_fix),
      sats: num(r.satellites),
      mode: r.mode ? r.mode.toLowerCase() : undefined,
      bms: (ex.bms as Sample['bms']) ?? null,
    });
  }
  samples.sort((a, b) => a.t - b.t);

  const telemetry: ReturnType<typeof envelope>[] = [];
  let lastBattery = -Infinity;
  for (let i = 0; i < samples.length; i += TELEMETRY_CHUNK) {
    const chunk = samples.slice(i, i + TELEMETRY_CHUNK);
    const gps = chunk.map((s) => ({ ts: iso(s.t), lat: s.lat, lon: s.lon, alt_m: s.alt, speed_mps: s.speed, heading_deg: s.heading, fix: s.fix }));
    const battery = [];
    for (const s of chunk) {
      if (s.bms?.soc === undefined || s.t - lastBattery < BATTERY_EVERY_MS) continue;
      lastBattery = s.t;
      battery.push({ ts: iso(s.t), pct: num(s.bms.soc), voltage_v: num(s.bms.voltage), current_a: num(s.bms.current), temp_c: num(s.bms.temp_max) });
    }
    const last = chunk[chunk.length - 1].t;
    telemetry.push(envelope('telemetry', last, `${chunk[0].t}-${last}`, { gps, battery }, product));
  }

  const live: ReturnType<typeof envelope>[] = [];
  let lastLive = -Infinity;
  for (const s of samples) {
    if (s.t - lastLive < LIVE_EVERY_MS) continue;
    lastLive = s.t;
    live.push(
      envelope(
        'live',
        s.t,
        String(s.t),
        {
          mode: s.mode,
          position: { lat: s.lat, lon: s.lon, alt_m: s.alt, fix: s.fix, sats: s.sats, speed_mps: s.speed, heading_deg: s.heading },
          battery: s.bms?.soc !== undefined ? { pct: Math.min(100, Math.max(0, s.bms.soc)), voltage_v: num(s.bms.voltage) } : undefined,
        },
        product,
      ),
    );
  }
  return { telemetry, live, samples: samples.length };
}

interface Track {
  lat?: number;
  lon?: number;
}
interface Waypoint {
  sequence?: number;
  label?: string;
  lat?: number;
  lng?: number;
  alt?: number;
  reached?: boolean;
  reached_at?: string | null;
}

function missionItems(rows: Record<string, string | null>[], product: string) {
  const items: { end: ReturnType<typeof envelope>; report: Record<string, unknown>; missionId: string }[] = [];
  let skipped = 0;
  for (const r of rows) {
    const started = pgTime(r.started_at);
    const ended = pgTime(r.ended_at);
    if (!r.id || started === null || !inRange(started)) {
      skipped++;
      continue;
    }
    const data = json<{ track?: Track[]; waypoints?: Waypoint[]; notes?: string }>(r.report_data) ?? {};
    const track = thin(
      (data.track ?? []).filter((p) => validLatLon(num(p.lat), num(p.lon))).map((p) => [num(p.lon)!, num(p.lat)!]),
      MAX_PATH_POINTS,
    );
    const waypoints = (data.waypoints ?? [])
      .filter((w) => validLatLon(num(w.lat), num(w.lng)))
      .map((w, i) => {
        const at = pgTime(w.reached_at ?? null);
        return { sequence: num(w.sequence) ?? i, label: w.label || undefined, lat: num(w.lat)!, lng: num(w.lng)!, reached: Boolean(w.reached) || at !== null, reached_at: at === null ? null : iso(at) };
      });
    const result = r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : 'aborted';
    const actualPath = track.length >= 2 ? { type: 'LineString', coordinates: track } : undefined;
    const plannedPath = waypoints.length >= 2 ? { type: 'LineString', coordinates: waypoints.map((w) => [w.lng, w.lat]) } : undefined;
    const distance = Math.max(0, num(r.distance_covered_m) ?? 0);
    const endTs = ended ?? started;

    items.push({
      missionId: r.id,
      end: envelope(
        'mission',
        endTs,
        r.id,
        { phase: 'end', mission_id: r.id, name: r.mission_name ?? undefined, started_at: iso(started), ended_at: iso(endTs), distance_m: distance, result, actual_path: actualPath },
        product,
      ),
      report: {
        v: 1,
        robot_id: ROBOT,
        external_id: r.id,
        gcs_mission_id: r.mission_id ?? undefined,
        name: r.mission_name ?? undefined,
        started_at: iso(started),
        ended_at: iso(endTs),
        distance_m: distance,
        distance_planned_m: Math.max(0, num(r.distance_planned_m) ?? 0),
        result,
        end_reason: data.notes || undefined,
        planned_path: plannedPath,
        actual_path: actualPath,
        waypoints_total: num(r.waypoints_total),
        waypoints_reached: num(r.waypoints_reached),
        waypoints,
        import_source: SOURCE,
      },
    });
  }
  return { items, skipped };
}

// ── store ───────────────────────────────────────────────────────────────────

/** Same as the ingest pipeline's store-once, minus the last-seen bump (this is history, not a live robot). */
async function storeMessage(tx: PoolClient, raw: ReturnType<typeof envelope>): Promise<boolean> {
  const parsed = parseRobotMessage(raw);
  if (!parsed.ok) throw new Error(`${raw.type} ${raw.msg_id}: ${parsed.error} ${JSON.stringify(parsed.details).slice(0, 500)}`);
  const msg = parsed.message;
  const inserted = await tx.query(
    `INSERT INTO ingested_messages (msg_id, robot_id, type, v, ts, client_id, transport, raw)
     VALUES ($1, $2, $3, $4, $5, NULL, 'https', $6) ON CONFLICT (msg_id) DO NOTHING`,
    [msg.msg_id, msg.robot_id, msg.type, msg.v, msg.ts, JSON.stringify(raw)],
  );
  if (!inserted.rowCount) return false;
  if (msg.type === 'telemetry') await handleTelemetry(tx, msg);
  else if (msg.type === 'live') await handleLive(tx, msg);
  else if (msg.type === 'mission') await handleMission(tx, msg);
  return true;
}

async function main(): Promise<void> {
  console.log(`reading ${FILE} …`);
  const tables = await readTables(FILE!);
  const bots = tables.get('public.apis_bot') ?? [];
  console.log(`GCS bots in dump: ${bots.map((b) => b.name).join(', ') || '(none)'} → all imported as ${ROBOT}`);

  const pool = createPool();
  const robot = (await pool.query<{ code: string }>('SELECT p.code FROM robots r JOIN products p ON p.id = r.product_id WHERE r.robot_id = $1 AND r.deleted_at IS NULL', [ROBOT])).rows[0];
  if (!robot) throw new Error(`robot ${ROBOT} is not registered`);

  const tel = telemetryMessages(tables.get('public.apis_ugvtelemetry') ?? [], robot.code);
  const mis = missionItems(tables.get('public.apis_missionreport') ?? [], robot.code);
  console.log(`window ${iso(START)} … ${Number.isFinite(END) ? iso(END) : 'end'}`);
  console.log(`GPS samples ${tel.samples} → ${tel.telemetry.length} telemetry messages, ${tel.live.length} live messages`);
  console.log(`mission reports: ${mis.items.length} in window, ${mis.skipped} outside it or without a start time`);

  // Validate everything before writing anything.
  for (const m of [...tel.telemetry, ...tel.live, ...mis.items.map((i) => i.end)]) {
    const p = parseRobotMessage(m);
    if (!p.ok) throw new Error(`${m.type} ${m.msg_id} invalid: ${p.error} ${JSON.stringify(p.details).slice(0, 500)}`);
  }
  for (const i of mis.items) {
    const p = gcsMissionReportSchema.safeParse(i.report);
    if (!p.success) throw new Error(`report ${i.missionId} invalid: ${p.error.message.slice(0, 500)}`);
  }
  console.log('all messages valid');
  if (DRY) {
    console.log('dry run: nothing written');
    await pool.end();
    return;
  }

  let stored = 0;
  let dup = 0;
  const all = [...tel.telemetry, ...tel.live].sort((a, b) => a.ts.localeCompare(b.ts));
  for (let i = 0; i < all.length; i += 200) {
    const batch = all.slice(i, i + 200);
    await withTransaction(pool, async (tx) => {
      for (const m of batch) (await storeMessage(tx, m)) ? stored++ : dup++;
    });
    process.stdout.write(`\rtelemetry/live ${Math.min(i + 200, all.length)}/${all.length}`);
  }
  console.log();
  for (const item of mis.items) {
    await withTransaction(pool, async (tx) => {
      (await storeMessage(tx, item.end)) ? stored++ : dup++;
      await mergeGcsReport(tx, item.missionId, gcsMissionReportSchema.parse(item.report), item.report);
    });
  }
  console.log(`done: ${stored} messages stored, ${dup} already there; ${mis.items.length} missions merged`);
  await pool.end();
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
