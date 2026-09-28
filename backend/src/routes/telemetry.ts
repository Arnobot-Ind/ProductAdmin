import type { BatteryPointDto, EncoderPointDto, GpsPointDto, HealthLevel, HealthPointDto, TelemetrySeriesDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';
import { robotParam, route } from '../lib/route';
import { isoDateTime } from '../lib/validation';

const RAW_LIMIT = 5000;
const TARGET_POINTS = 1000;
const BUCKETS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];
const MAX_RANGE_DAYS = 400;

const rangeQuery = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  /** 0 = raw rows; omitted = automatic (≈ ≤ 1000 points). */
  bucket_s: z.coerce.number().int().min(0).max(86400).optional(),
});

function resolveRange(q: z.infer<typeof rangeQuery>): { from: Date; to: Date; bucket: number } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 24 * 3600_000);
  if (from >= to) throw badRequest('from must be before to');
  const rangeS = (to.getTime() - from.getTime()) / 1000;
  if (rangeS > MAX_RANGE_DAYS * 86400) throw badRequest(`range is limited to ${MAX_RANGE_DAYS} days`);
  // Samples arrive in 30 s batches, typically ~1 Hz inside a batch; raw is fine for short ranges.
  const bucket = q.bucket_s ?? (rangeS <= 1800 ? 0 : BUCKETS.find((b) => rangeS / b <= TARGET_POINTS) ?? 86400);
  return { from, to, bucket };
}

const HEALTH_RANK = `CASE %s WHEN 'fault' THEN 2 WHEN 'warning' THEN 1 WHEN 'ok' THEN 0 END`;
const worst = (col: string) =>
  `(ARRAY['ok','warning','fault'])[max(${HEALTH_RANK.replace('%s', col)}) + 1]`;

/**
 * Sensor history (spec §3 row 11). Downsampling uses PostgreSQL's native date_bin(), so it works on
 * plain PostgreSQL and on TimescaleDB hypertables alike. Health buckets report the WORST state seen.
 */
export function telemetryRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, robots } = app;
  const tag = 'Telemetry';
  const access = { can: 'robot.read', target: robotParam() };

  async function series<T>(robotId: string, q: z.infer<typeof rangeQuery>, rawSql: string, bucketSql: string): Promise<TelemetrySeriesDto<T>> {
    await robots.assertExists(robotId, { allowDeleted: true });
    const { from, to, bucket } = resolveRange(q);
    const sql = bucket === 0 ? `${rawSql} LIMIT ${RAW_LIMIT}` : bucketSql;
    const params = bucket === 0 ? [robotId, from, to] : [robotId, from, to, `${bucket} seconds`];
    const rows = await db.query(sql, params);
    return {
      robot_id: robotId,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket_s: bucket,
      points: rows.rows.map((r) => ({ ...r, ts: (r.ts as Date).toISOString() })) as T[],
    };
  }
  const W = 'WHERE robot_id = $1 AND ts >= $2 AND ts < $3';
  const BIN = `date_bin($4::interval, ts, TIMESTAMPTZ '2000-01-01')`;

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/telemetry/gps',
    summary: 'GPS track (averaged per bucket)',
    tag,
    access,
    query: rangeQuery,
    handler: ({ params, query }) =>
      series<GpsPointDto>(
        params.robotId,
        query,
        `SELECT ts, lat, lon, alt_m, speed_mps, heading_deg, fix_quality AS fix FROM telemetry_gps ${W} ORDER BY ts`,
        `SELECT ${BIN} AS ts, avg(lat) AS lat, avg(lon) AS lon, avg(alt_m)::real AS alt_m, avg(speed_mps)::real AS speed_mps,
                (array_agg(heading_deg ORDER BY ts DESC))[1] AS heading_deg, (array_agg(fix_quality ORDER BY ts DESC))[1] AS fix
         FROM telemetry_gps ${W} GROUP BY 1 ORDER BY 1`,
      ),
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/telemetry/battery',
    summary: 'Battery history',
    tag,
    access,
    query: rangeQuery,
    handler: ({ params, query }) =>
      series<BatteryPointDto>(
        params.robotId,
        query,
        `SELECT ts, pct, voltage_v, current_a, temp_c FROM telemetry_battery ${W} ORDER BY ts`,
        `SELECT ${BIN} AS ts, avg(pct)::real AS pct, avg(voltage_v)::real AS voltage_v, avg(current_a)::real AS current_a, avg(temp_c)::real AS temp_c
         FROM telemetry_battery ${W} GROUP BY 1 ORDER BY 1`,
      ),
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/telemetry/encoders',
    summary: 'Encoder readings per encoder',
    tag,
    access,
    query: rangeQuery,
    handler: ({ params, query }) =>
      series<EncoderPointDto>(
        params.robotId,
        query,
        `SELECT ts, encoder, ticks, velocity_mps, rpm FROM telemetry_encoder ${W} ORDER BY ts, encoder`,
        `SELECT ${BIN} AS ts, encoder, (array_agg(ticks ORDER BY ts DESC))[1] AS ticks,
                avg(velocity_mps)::real AS velocity_mps, avg(rpm)::real AS rpm
         FROM telemetry_encoder ${W} GROUP BY 1, 2 ORDER BY 1, 2`,
      ),
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/telemetry/health',
    summary: 'Device health + temperatures (worst state per bucket)',
    tag,
    access,
    query: rangeQuery,
    handler: async ({ params, query }) => {
      const motorsMax = `(SELECT max(value::float8) FROM jsonb_each_text(temp_motors_c))`;
      const s = await series<HealthPointDto & { health_controller?: HealthLevel }>(
        params.robotId,
        query,
        `SELECT ts, health_controller AS controller, health_lidar AS lidar, health_cameras AS cameras, health_gps AS gps,
                temp_controller_c, temp_battery_c, ${motorsMax}::real AS temp_motors_max_c
         FROM telemetry_health ${W} ORDER BY ts`,
        `SELECT ${BIN} AS ts, ${worst('health_controller')} AS controller, ${worst('health_lidar')} AS lidar,
                ${worst('health_cameras')} AS cameras, ${worst('health_gps')} AS gps,
                avg(temp_controller_c)::real AS temp_controller_c, avg(temp_battery_c)::real AS temp_battery_c,
                max(${motorsMax})::real AS temp_motors_max_c
         FROM telemetry_health ${W} GROUP BY 1 ORDER BY 1`,
      );
      return s;
    },
  });
}
