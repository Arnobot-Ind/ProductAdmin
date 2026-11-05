import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StorageUsageDto, SystemStatusDto } from '../shared';
import type { AppContext } from '../context';
import { platform, route } from '../lib/route';
import { ROBOT_STATUS_SQL } from '../lib/robot-status-sql';

/** Schema version this server needs (latest migration in storage/migrations it relies on). */
const REQUIRED_SCHEMA_VERSION = 17;

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** The whole bucket is listed to measure it, so one result serves everyone for an hour. */
const STORAGE_CACHE_MS = 3_600_000;

/** Fills in the days with no uploads, so the running total is a continuous line up to today. */
function storageDaily(days: Map<string, number>, today: string): StorageUsageDto['daily'] {
  const first = [...days.keys()].sort()[0];
  if (!first) return [];
  const out: StorageUsageDto['daily'] = [];
  let total = 0;
  for (let t = Date.parse(first); ; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (date > today) break;
    const added = days.get(date) ?? 0;
    total += added;
    out.push({ date, added_bytes: added, total_bytes: total });
  }
  return out;
}

/** Settings page: is the server up, is the database connected, are the stores reachable, who is sending data. */
export function systemRoutes(f: FastifyInstance, app: AppContext): void {
  let storageUsage: { at: number; result: Promise<StorageUsageDto> } | null = null;
  const measureStorage = async (): Promise<StorageUsageDto> => {
    const [bucket, db] = await Promise.all([
      app.archive.storage.usageByDay(),
      app.db.query<{ size: string }>('SELECT pg_database_size(current_database())::bigint AS size'),
    ]);
    const database = Number(db.rows[0].size);
    const now = new Date();
    return {
      checked_at: now.toISOString(),
      total_bytes: bucket.bytes + database,
      files_bytes: bucket.bytes,
      files_count: bucket.objects,
      database_bytes: database,
      daily: storageDaily(bucket.days, now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })),
    };
  };

  route(f, app, {
    method: 'GET',
    path: '/system/storage',
    summary: 'Storage used on AWS: the S3 bucket and the database, with the bucket growth per day (main dashboard). Arnobot staff only',
    tag: 'Meta',
    access: { can: 'system.read', target: platform() },
    handler: async (): Promise<StorageUsageDto> => {
      if (!storageUsage || Date.now() - storageUsage.at > STORAGE_CACHE_MS) {
        const entry = { at: Date.now(), result: measureStorage() };
        storageUsage = entry;
        // A failed measurement is not kept: the next request tries again.
        entry.result.catch(() => {
          if (storageUsage === entry) storageUsage = null;
        });
      }
      return storageUsage.result;
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/system/status',
    summary: 'Server, database, storage, ffmpeg and fleet link status (Settings page). Arnobot staff only: it shows fleet-wide counts',
    tag: 'Meta',
    access: { can: 'system.read', target: platform() },
    handler: async (): Promise<SystemStatusDto> => {
      const db: SystemStatusDto['database'] = {
        ok: false,
        latency_ms: null,
        version: null,
        name: null,
        size_bytes: null,
        migrations: { applied: 0, pending: 0, latest: null },
        error: null,
      };
      let robots: SystemStatusDto['robots'] = { total: 0, online: 0, offline: 0, sending_data: 0, recording: 0 };
      let archiveStats: SystemStatusDto['archive'] = { sessions: 0, files: 0, bytes: 0, last_upload_at: null };
      try {
        const info = (
          await app.db.query<{ version: string; name: string; size: number }>(
            'SELECT current_setting(\'server_version\') AS version, current_database() AS name, pg_database_size(current_database())::bigint AS size',
          )
        ).rows[0];
        // Round trip on a warm pooled connection (the first query may include connecting).
        const t0 = performance.now();
        await app.db.query('SELECT 1');
        db.latency_ms = Math.round((performance.now() - t0) * 10) / 10;
        db.ok = true;
        db.version = info.version;
        db.name = info.name;
        db.size_bytes = Number(info.size);
        // Migrations are owned by storage/ (npm run db:migrate there); the server only reads what is applied.
        const mig = (
          await app.db.query<{ n: number; latest: string | null; v: number | null }>(
            "SELECT count(*)::int AS n, max(version) AS v, (SELECT lpad(version::text, 4, '0') || '_' || name || '.sql' FROM schema_migrations ORDER BY version DESC LIMIT 1) AS latest FROM schema_migrations",
          )
        ).rows[0];
        db.migrations = { applied: mig.n, pending: Math.max(0, REQUIRED_SCHEMA_VERSION - (mig.v ?? 0)), latest: mig.latest };
        const r = (
          await app.db.query<SystemStatusDto['robots']>(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE s.status = 'online')::int AS online,
                    count(*) FILTER (WHERE s.status = 'offline')::int AS offline,
                    count(*) FILTER (WHERE now() - l.last_upload_at < interval '2 minutes')::int AS sending_data,
                    count(*) FILTER (WHERE now() - l.last_seen_at < interval '5 minutes' AND l.last_status->'session'->>'session_id' IS NOT NULL)::int AS recording
             FROM robots r JOIN ${ROBOT_STATUS_SQL} s ON s.robot_id = r.robot_id
             LEFT JOIN archive_robot_link l ON l.robot_id = r.robot_id
             WHERE r.deleted_at IS NULL`,
          )
        ).rows[0];
        robots = r;
        archiveStats = await app.archive.stats();
      } catch (e) {
        db.error = (e as Error).message;
      }
      const [documents, archive, ffmpeg] = await Promise.all([app.storage.health(), app.archive.storage.health(), app.archive.mp4.ffmpeg()]);
      return {
        checked_at: new Date().toISOString(),
        server: {
          ok: true,
          version: VERSION,
          node: process.version,
          started_at: app.runtime.startedAt.toISOString(),
          uptime_s: Math.round(process.uptime()),
          port: app.cfg.port,
          environment: process.env.NODE_ENV || 'development',
        },
        database: db,
        storage: {
          documents: { ok: documents.ok, driver: documents.driver, detail: documents.detail ?? null },
          archive: { ok: archive.ok, driver: app.archive.storage.driver, location: app.archive.storage.location, detail: archive.detail ?? null },
        },
        ffmpeg,
        mqtt: { configured: Boolean(app.cfg.ingest.mqttUrl), connected: app.runtime.mqttConnected() },
        robots,
        archive: archiveStats,
      };
    },
  });
}
