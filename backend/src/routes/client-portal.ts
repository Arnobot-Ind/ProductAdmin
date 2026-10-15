/**
 * Customer-safe data for the client app (0021), each behind a client-app feature. Staff routes for the same data
 * (events, telemetry) need robot.details and return internal fields; these need only robot.read, strip internal
 * fields, and keep every row inside what the user may see (their robots, their organization's periods, the data
 * history limit). No CSV and no video here, by design.
 */
import { CLIENT_FEATURES, EVENT_SEVERITIES, EVENT_TYPES, type BatteryPointDto, type ClientEventDto, type ClientSoftwareDto, type GpsPointDto, type HealthPointDto, type Paginated, type TelemetrySeriesDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';
import { anyScope, assertFeature, robotParam, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { isoDateTime, pageQuery, robotIdSchema } from '../lib/validation';
import { INSTALL_SELECT, toInstall } from '../services/client-admin';
import type { AuthUser } from '../services/auth.service';

const TARGET_POINTS = 1000;
const BUCKETS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];
const MAX_RANGE_DAYS = 31;

const rangeQuery = z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() });

/** Default last 24 h, at most 31 days, always bucketed to ≈ ≤ 1000 points (the client app draws charts, not tables). */
function resolveRange(q: z.infer<typeof rangeQuery>): { from: Date; to: Date; bucket: number } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 24 * 3600_000);
  if (from >= to) throw badRequest('from must be before to');
  const rangeS = (to.getTime() - from.getTime()) / 1000;
  if (rangeS > MAX_RANGE_DAYS * 86400) throw badRequest(`range is limited to ${MAX_RANGE_DAYS} days`);
  return { from, to, bucket: BUCKETS.find((b) => rangeS / b <= TARGET_POINTS) ?? 86400 };
}

const HEALTH_RANK = `CASE %s WHEN 'fault' THEN 2 WHEN 'warning' THEN 1 WHEN 'ok' THEN 0 END`;
const worst = (col: string) => `(ARRAY['ok','warning','fault'])[max(${HEALTH_RANK.replace('%s', col)}) + 1]`;
const W = 'WHERE robot_id = $1 AND ts >= $2 AND ts < $3';
const BIN = `date_bin($4::interval, ts, TIMESTAMPTZ '2000-01-01')`;

const KINDS = {
  battery: `SELECT ${BIN} AS ts, avg(pct)::real AS pct, avg(voltage_v)::real AS voltage_v, avg(current_a)::real AS current_a, avg(temp_c)::real AS temp_c
            FROM telemetry_battery ${W} GROUP BY 1 ORDER BY 1`,
  health: `SELECT ${BIN} AS ts, ${worst('health_controller')} AS controller, ${worst('health_lidar')} AS lidar,
                  ${worst('health_cameras')} AS cameras, ${worst('health_gps')} AS gps,
                  avg(temp_controller_c)::real AS temp_controller_c, avg(temp_battery_c)::real AS temp_battery_c,
                  max((SELECT max(value::float8) FROM jsonb_each_text(temp_motors_c)))::real AS temp_motors_max_c
           FROM telemetry_health ${W} GROUP BY 1 ORDER BY 1`,
  gps: `SELECT ${BIN} AS ts, avg(lat) AS lat, avg(lon) AS lon, avg(alt_m)::real AS alt_m, avg(speed_mps)::real AS speed_mps,
               (array_agg(heading_deg ORDER BY ts DESC))[1] AS heading_deg, (array_agg(fix_quality ORDER BY ts DESC))[1] AS fix
        FROM telemetry_gps ${W} GROUP BY 1 ORDER BY 1`,
} as const;

const EVENT_SELECT = 'SELECT e.id, e.robot_id, e.ts, e.type, e.severity, e.code, e.message FROM events e';
const toEvent = (r: Record<string, unknown>): ClientEventDto => ({ ...(r as unknown as ClientEventDto), ts: iso(r.ts as Date)! });
const eventQuery = z.object({
  robot: robotIdSchema.optional(),
  type: z.enum(EVENT_TYPES).optional(),
  severity: z.enum(EVENT_SEVERITIES).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  ...pageQuery,
});

export function clientPortalRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, robots } = app;
  const tag = 'Client app';

  const events = (user: AuthUser, q: z.infer<typeof eventQuery>, robotId?: string): Promise<Paginated<ClientEventDto>> => {
    const w = app.perms.applyDataScope(new Where(), app.perms.robotScope(user, 'robot.read'), 'e.robot_id', 'e.ts');
    if (robotId ?? q.robot) w.add('e.robot_id = ?', robotId ?? q.robot);
    if (q.type) w.add('e.type = ?', q.type);
    if (q.severity) w.add('e.severity = ?', q.severity);
    if (q.from) w.add('e.ts >= ?', q.from);
    if (q.to) w.add('e.ts < ?', q.to);
    return paginate(db, EVENT_SELECT, w, 'e.ts DESC, e.id', q.page, q.limit, toEvent) as Promise<Paginated<ClientEventDto>>;
  };

  route(f, app, {
    method: 'GET',
    path: '/client/events',
    summary: 'Events of the robots the user may see (alerts, faults, aborts, return-to-home)',
    tag,
    access: { can: 'robot.read', target: anyScope() },
    feature: CLIENT_FEATURES.eventsView,
    query: eventQuery,
    handler: ({ query, user }) => events(user, query),
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/client/events',
    summary: 'Events of one robot',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    feature: CLIENT_FEATURES.eventsView,
    query: eventQuery.omit({ robot: true }),
    handler: ({ params, query, user }) => events(user, query, params.robotId),
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/client/telemetry/:kind',
    summary: `Battery, health or GPS history of one robot, bucketed for charts (default last 24 h, at most ${MAX_RANGE_DAYS} days). GPS also needs the location feature`,
    tag,
    access: { can: 'robot.read', target: robotParam() },
    feature: CLIENT_FEATURES.telemetryView,
    query: rangeQuery,
    handler: async ({ params, query, user, req }): Promise<TelemetrySeriesDto<BatteryPointDto | HealthPointDto | GpsPointDto>> => {
      const kind = params.kind as keyof typeof KINDS;
      if (!(kind in KINDS)) throw badRequest('kind must be battery, health or gps');
      if (kind === 'gps') assertFeature(app, req, user, CLIENT_FEATURES.robotsLocation, params.robotId);
      await robots.assertExists(params.robotId, { allowDeleted: true });
      const { from, to, bucket } = resolveRange(query);
      const periods = await app.perms.dataPeriods(user, 'robot.read', params.robotId);
      const spans = (periods ?? [{ from, to }])
        .map((p) => ({ from: new Date(Math.max(from.getTime(), (p.from ?? from).getTime())), to: new Date(Math.min(to.getTime(), (p.to ?? to).getTime())) }))
        .filter((s) => s.from < s.to);
      const points: Record<string, unknown>[] = [];
      for (const s of spans) points.push(...(await db.query(KINDS[kind], [params.robotId, s.from, s.to, `${bucket} seconds`])).rows);
      return {
        robot_id: params.robotId,
        from: from.toISOString(),
        to: to.toISOString(),
        bucket_s: bucket,
        points: points.map((r) => ({ ...r, ts: (r.ts as Date).toISOString() })) as unknown as (BatteryPointDto | HealthPointDto | GpsPointDto)[],
      };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/client/software',
    summary: "The organization's Arnobot software and licences (installs on robots the user cannot see are left out)",
    tag,
    access: { can: 'robot.read', target: anyScope() },
    feature: CLIENT_FEATURES.softwareView,
    handler: async ({ user }): Promise<ClientSoftwareDto[]> => {
      const w = new Where().add('i.deleted_at IS NULL').add('i.company_id = ?', user.companyId);
      // Robot-bound installs follow the robot rule; the rest belong to the whole organization.
      // (shares w's params, so its placeholders continue w's numbering)
      const scoped = app.perms.applyRobotScope(new Where(w.params), app.perms.robotScope(user, 'robot.read'), 'i.robot_id');
      if (scoped.parts.length) w.add(`(i.robot_id IS NULL OR (${scoped.parts.join(' AND ')}))`);
      const rows = (await db.query(`${INSTALL_SELECT} ${w.toSql()} ORDER BY s.name, i.robot_id NULLS FIRST`, w.params)).rows.map(toInstall);
      return rows.map(({ notes: _notes, company_id: _company, ...rest }) => rest);
    },
  });
}
