import type { ClientMissionDto, ClientMissionReportDto, ReportCalendarDayDto, ClientMissionsDto, DailyDistanceDto, DayReportDto, FleetReportDto, MissionStatsDto, RobotStatus } from '../shared';
import { MISSION_STATES } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, notFound } from '../lib/errors';
import { anyScope, robotParam, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { isoDate, pageQuery } from '../lib/validation';
import type { AuthUser } from '../services/auth.service';
import { reportWaypoints } from './missions';
import { computeDayReport, istDate, istInstant, reportWindow, type BatterySample, type GpsSample, type LiveSample } from '../services/day-report';

const hm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/, 'HH:MM (IST)');
const MAX_DAYS = 92;

/** A number from a JSON text field, or NULL when it is missing or not numeric (raw messages are kept as sent). */
const num = (expr: string) => `CASE WHEN (${expr}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${expr})::float8 END`;
const LIVE_SELECT = `
SELECT ts,
       ${num("raw->'payload'->>'odometer_m'")} AS odometer_m,
       ${num("raw->'payload'->'position'->>'sats'")} AS sats,
       raw->'payload'->'position'->>'fix' AS fix,
       ${num("raw->'payload'->'battery'->>'pct'")} AS battery_pct
FROM ingested_messages WHERE robot_id = $1 AND type = 'live' AND ts >= $2 AND ts < $3`;

/** When a mission happened, for period filters and the data scope. */
const MISSION_TIME = 'coalesce(m.started_at, m.created_at)';
const STATS_SELECT = `count(*)::int AS total,
       count(*) FILTER (WHERE m.result = 'completed')::int AS completed,
       count(*) FILTER (WHERE m.result = 'aborted')::int AS aborted,
       count(*) FILTER (WHERE m.result = 'failed')::int AS failed,
       count(*) FILTER (WHERE m.result = 'in_progress')::int AS in_progress,
       coalesce(sum(m.distance_m), 0)::float8 AS distance_m,
       coalesce(sum(m.duration_s), 0)::float8 AS duration_s`;
const toStats = (r: Record<string, unknown> | undefined): MissionStatsDto => ({
  total: Number(r?.total ?? 0),
  completed: Number(r?.completed ?? 0),
  aborted: Number(r?.aborted ?? 0),
  failed: Number(r?.failed ?? 0),
  in_progress: Number(r?.in_progress ?? 0),
  distance_m: Math.round(Number(r?.distance_m ?? 0)),
  duration_s: Math.round(Number(r?.duration_s ?? 0)),
});
const MAX_MISSION_PATH_POINTS = 4000;
/** GeoJSON LineString ([lon, lat]) -> [lat, lon] points for the report map, evenly thinned; null when absent. */
function pathPoints(path: unknown): [number, number][] | null {
  const coords = (path as { coordinates?: unknown } | null)?.coordinates;
  if (!Array.isArray(coords)) return null;
  const pts = coords
    .filter((c): c is number[] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map((c) => [c[1], c[0]] as [number, number]);
  if (pts.length < 2) return null;
  if (pts.length <= MAX_MISSION_PATH_POINTS) return pts;
  const step = (pts.length - 1) / (MAX_MISSION_PATH_POINTS - 1);
  return Array.from({ length: MAX_MISSION_PATH_POINTS }, (_, i) => pts[Math.round(i * step)]);
}

/** Optional IST day range -> [start, end) instants. */
function dayRange(from?: string, to?: string): { start: Date | null; end: Date | null } {
  const start = from ? istInstant(from, '00:00') : null;
  const end = to ? istInstant(to, '24:00') : null;
  if (start && end && end <= start) throw badRequest('from must not be after to');
  return { start, end };
}

/**
 * Day-wise reports of one robot (customer view, 0020): the patrol / night-surveillance report for an IST window and
 * distance by day. Both need only robot.read, so customer users get them; both are clipped to the time the user
 * may see (never data recorded while another customer owned the robot).
 */
export function reportRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, robots } = app;
  const tag = 'Reports';

  /** [from, to) intersected with the periods the user may see. */
  async function visibleSpans(user: AuthUser, robotId: string, from: Date, to: Date): Promise<{ from: Date; to: Date }[]> {
    const periods = await app.perms.dataPeriods(user, 'robot.read', robotId);
    return (periods ?? [{ from, to }])
      .map((p) => ({ from: new Date(Math.max(from.getTime(), (p.from ?? from).getTime())), to: new Date(Math.min(to.getTime(), (p.to ?? to).getTime())) }))
      .filter((s) => s.from < s.to);
  }
  async function rowsIn<T>(sql: string, robotId: string, spans: { from: Date; to: Date }[]): Promise<T[]> {
    const out: T[] = [];
    for (const s of spans) out.push(...(await db.query(sql, [robotId, s.from, s.to])).rows);
    return out;
  }

  /** Distance, time moving and time online per IST day of [start, end) for one robot, clipped to what the user may see. */
  async function dailyDistance(user: AuthUser, robotId: string, start: Date, end: Date): Promise<DailyDistanceDto[]> {
    const spans = await visibleSpans(user, robotId, start, end);
    const DAY = "(ts AT TIME ZONE 'Asia/Kolkata')::date::text";

    const wheel = await rowsIn<{ d: string; wheel_m: number; moving_s: number }>(
      `WITH g AS (SELECT ts, speed_mps, extract(epoch FROM ts - lag(ts) OVER (ORDER BY ts)) AS dt
                  FROM telemetry_gps WHERE robot_id = $1 AND ts >= $2 AND ts < $3)
       SELECT ${DAY} AS d,
              coalesce(sum(speed_mps * dt) FILTER (WHERE speed_mps > 0.05 AND dt > 0 AND dt <= 10), 0)::float8 AS wheel_m,
              coalesce(sum(dt) FILTER (WHERE speed_mps > 0.05 AND dt > 0 AND dt <= 10), 0)::float8 AS moving_s
       FROM g GROUP BY 1`,
      robotId,
      spans,
    );
    const online = await rowsIn<{ d: string; minutes: number; first: Date; last: Date }>(
      `SELECT d, count(DISTINCT m)::int AS minutes, min(ts) AS first, max(ts) AS last FROM (
         SELECT ${DAY} AS d, date_trunc('minute', ts) AS m, ts FROM telemetry_gps WHERE robot_id = $1 AND ts >= $2 AND ts < $3
         UNION ALL
         SELECT ${DAY}, date_trunc('minute', ts), ts FROM ingested_messages WHERE robot_id = $1 AND type = 'live' AND ts >= $2 AND ts < $3
       ) x GROUP BY d`,
      robotId,
      spans,
    );
    // Odometer increases between consecutive live messages; resets and impossible jumps (> 6 m/s) are skipped.
    const odo = await rowsIn<{ d: string; odometer_m: number; odo_end: number }>(
      `WITH o AS (SELECT ts, odometer_m AS odo, lag(odometer_m) OVER (ORDER BY ts) AS po, extract(epoch FROM ts - lag(ts) OVER (ORDER BY ts)) AS dt
                  FROM (${LIVE_SELECT}) l WHERE odometer_m IS NOT NULL)
       SELECT ${DAY} AS d,
              coalesce(sum(odo - po) FILTER (WHERE odo - po > 0 AND odo - po <= greatest(dt, 1) * 6), 0)::float8 AS odometer_m,
              max(odo) AS odo_end
       FROM o GROUP BY 1`,
      robotId,
      spans,
    );

    const days = new Map<string, DailyDistanceDto>();
    const day = (d: string) => {
      let row = days.get(d);
      if (!row) {
        row = { date: d, odometer_m: null, wheel_m: 0, moving_s: 0, online_s: 0, first_seen_at: null, last_seen_at: null, odometer_end_m: null };
        days.set(d, row);
      }
      return row;
    };
    for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) day(istDate(new Date(t)));
    for (const r of wheel) Object.assign(day(r.d), { wheel_m: day(r.d).wheel_m + r.wheel_m, moving_s: day(r.d).moving_s + r.moving_s });
    for (const r of online) {
      const row = day(r.d);
      row.online_s += r.minutes * 60;
      if (!row.first_seen_at || r.first.toISOString() < row.first_seen_at) row.first_seen_at = r.first.toISOString();
      if (!row.last_seen_at || r.last.toISOString() > row.last_seen_at) row.last_seen_at = r.last.toISOString();
    }
    for (const r of odo) {
      const row = day(r.d);
      row.odometer_m = (row.odometer_m ?? 0) + r.odometer_m;
      row.odometer_end_m = Math.max(row.odometer_end_m ?? 0, r.odo_end);
    }
    return [...days.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ ...r, wheel_m: Math.round(r.wheel_m), moving_s: Math.round(r.moving_s), odometer_m: r.odometer_m === null ? null : Math.round(r.odometer_m) }));
  }

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/reports/day',
    summary: 'Patrol report figures for one IST window (default the whole day); `to` before `from` runs past midnight',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    query: z.object({ date: isoDate, from: hm.optional(), to: hm.optional() }),
    handler: async ({ params, query, user }): Promise<DayReportDto> => {
      const robot = await robots.detail(params.robotId);
      const { start, end } = reportWindow(query.date, query.from, query.to);
      const spans = await visibleSpans(user, params.robotId, start, end);
      const visibleMs = spans.reduce((n, s) => n + (s.to.getTime() - s.from.getTime()), 0);

      const gps = await rowsIn<GpsSample>(
        'SELECT ts, lat, lon, speed_mps AS speed, fix_quality AS fix FROM telemetry_gps WHERE robot_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts',
        params.robotId,
        spans,
      );
      const live = await rowsIn<LiveSample>(`${LIVE_SELECT} ORDER BY ts`, params.robotId, spans);
      const battery = await rowsIn<BatterySample>('SELECT ts, pct FROM telemetry_battery WHERE robot_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts', params.robotId, spans);
      const missions = await rowsIn<{ mission_id: string; name: string | null; started_at: Date | null; ended_at: Date | null; result: DayReportDto['missions'][number]['result']; distance_m: number | null }>(
        `SELECT mission_id, name, started_at, ended_at, result, distance_m FROM missions
         WHERE robot_id = $1 AND coalesce(started_at, created_at) >= $2 AND coalesce(started_at, created_at) < $3 ORDER BY coalesce(started_at, created_at)`,
        params.robotId,
        spans,
      );

      return computeDayReport({
        robot: { robot_id: robot.robot_id, robot_name: robot.robot_id.toUpperCase(), product_name: robot.product_name, owner_company: robot.owner_company },
        date: query.date,
        start,
        end,
        clipped: visibleMs < end.getTime() - start.getTime(),
        gps,
        live,
        battery,
        missions: missions.map((m) => ({ ...m, started_at: m.started_at?.toISOString() ?? null, ended_at: m.ended_at?.toISOString() ?? null })),
      });
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/reports/daily-distance',
    summary: `Distance driven, time moving and time online per IST day (at most ${MAX_DAYS} days)`,
    tag,
    access: { can: 'robot.read', target: robotParam() },
    query: z.object({ from: isoDate, to: isoDate }),
    handler: async ({ params, query, user }): Promise<DailyDistanceDto[]> => {
      await robots.assertExists(params.robotId, { allowDeleted: true });
      const start = istInstant(query.from, '00:00');
      const end = istInstant(query.to, '24:00');
      if (end <= start) throw badRequest('from must not be after to');
      if (end.getTime() - start.getTime() > MAX_DAYS * 86_400_000) throw badRequest(`at most ${MAX_DAYS} days at a time`);
      return dailyDistance(user, params.robotId, start, end);
    },
  });

  /** Missions of the user's visible data (never another customer's period) for one robot or all, in an optional range. */
  const missionWhere = (user: AuthUser, robotId: string | null, start: Date | null, end: Date | null, result?: string) => {
    const w = app.perms.applyDataScope(new Where(), app.perms.robotScope(user, 'robot.read'), 'm.robot_id', MISSION_TIME);
    w.add('EXISTS (SELECT 1 FROM robots rr WHERE rr.robot_id = m.robot_id AND rr.deleted_at IS NULL)');
    if (robotId) w.add('m.robot_id = ?', robotId);
    if (start) w.add(`${MISSION_TIME} >= ?`, start);
    if (end) w.add(`${MISSION_TIME} < ?`, end);
    if (result) w.add('m.result = ?', result);
    return w;
  };

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/reports/missions',
    summary: 'Mission counts and one page of missions (name, times, distance, result) for the client portal',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), result: z.enum(MISSION_STATES).optional(), ...pageQuery }),
    handler: async ({ params, query, user }): Promise<ClientMissionsDto> => {
      await robots.assertExists(params.robotId, { allowDeleted: true });
      const { start, end } = dayRange(query.from, query.to);
      // Stats cover the whole period (every result) so the result filter can show its counts.
      const sw = missionWhere(user, params.robotId, start, end);
      const stats = toStats((await db.query(`SELECT ${STATS_SELECT} FROM missions m ${sw.toSql()}`, sw.params)).rows[0]);
      const page = await paginate(
        db,
        `SELECT m.mission_id, m.name, m.started_at, m.ended_at, m.duration_s, m.distance_m, m.result, m.end_reason,
                m.distance_planned_m, m.waypoints_total, m.waypoints_reached, m.created_at FROM missions m`,
        missionWhere(user, params.robotId, start, end, query.result),
        `${MISSION_TIME} DESC`,
        query.page,
        query.limit,
        (r: Record<string, unknown>): ClientMissionDto => ({
          mission_id: r.mission_id as string,
          name: r.name as string | null,
          started_at: iso(r.started_at as Date | null),
          ended_at: iso(r.ended_at as Date | null),
          duration_s: r.duration_s as number | null,
          distance_m: r.distance_m as number | null,
          result: r.result as ClientMissionDto['result'],
          end_reason: r.end_reason as string | null,
          distance_planned_m: r.distance_planned_m as number | null,
          waypoints_total: r.waypoints_total as number | null,
          waypoints_reached: r.waypoints_reached as number | null,
        }),
      );
      return { robot_id: params.robotId, from: query.from ?? null, to: query.to ?? null, stats, items: page.items as ClientMissionDto[], total: page.total, page: page.page, limit: page.limit };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/reports/missions/:missionId',
    summary: 'One mission for its Mission Report PDF: times, result, distances and waypoint results',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    handler: async ({ params, user }): Promise<ClientMissionReportDto> => {
      const w = missionWhere(user, params.robotId, null, null).add('m.mission_id = ?', params.missionId);
      const m = (
        await db.query(
          `SELECT m.mission_id, m.robot_id, m.name, m.started_at, m.ended_at, m.duration_s, m.distance_m, m.distance_planned_m,
                  m.result, m.end_reason, m.waypoints_total, m.waypoints_reached, m.gcs_report, m.actual_path
           FROM missions m ${w.toSql()}`,
          w.params,
        )
      ).rows[0];
      if (!m) throw notFound('mission');
      return {
        mission_id: m.mission_id,
        robot_id: m.robot_id,
        name: m.name,
        started_at: iso(m.started_at),
        ended_at: iso(m.ended_at),
        duration_s: m.duration_s,
        distance_m: m.distance_m,
        distance_planned_m: m.distance_planned_m,
        result: m.result,
        end_reason: m.end_reason,
        waypoints_total: m.waypoints_total,
        waypoints_reached: m.waypoints_reached,
        waypoints: reportWaypoints(m.gcs_report),
        path: pathPoints(m.actual_path),
      };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/reports/calendar',
    summary: 'Reports calendar of one robot: missions and online time per IST day of a month',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM') }),
    handler: async ({ params, query, user }): Promise<ReportCalendarDayDto[]> => {
      await robots.assertExists(params.robotId, { allowDeleted: true });
      const [y, mo] = query.month.split('-').map(Number);
      const last = `${query.month}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
      const { start, end } = dayRange(`${query.month}-01`, last);
      const w = missionWhere(user, params.robotId, start, end);
      const perDay = new Map(
        (await db.query(`SELECT (${MISSION_TIME} AT TIME ZONE 'Asia/Kolkata')::date::text AS d, ${STATS_SELECT} FROM missions m ${w.toSql()} GROUP BY 1`, w.params)).rows.map((r) => [
          r.d as string,
          toStats(r),
        ]),
      );
      return (await dailyDistance(user, params.robotId, start!, end!)).map((d) => {
        const st = perDay.get(d.date) ?? toStats(undefined);
        return { date: d.date, missions: st.total, completed: st.completed, aborted: st.aborted, failed: st.failed, online_min: Math.round(d.online_s / 60), driven_m: d.odometer_m ?? d.wheel_m };
      });
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/reports/fleet',
    summary: `Client dashboard: missions and distance driven per robot and per IST day over [from, to] (at most ${MAX_DAYS} days)`,
    tag,
    access: { can: 'robot.read', target: anyScope() },
    query: z.object({ from: isoDate, to: isoDate }),
    handler: async ({ query, user }): Promise<FleetReportDto> => {
      const range = dayRange(query.from, query.to);
      const start = range.start!;
      const end = range.end!;
      if (end.getTime() - start.getTime() > MAX_DAYS * 86_400_000) throw badRequest(`at most ${MAX_DAYS} days at a time`);
      const rw = app.perms.applyRobotScope(new Where(), app.perms.robotScope(user, 'robot.read'), 'r.robot_id').add('r.deleted_at IS NULL');
      const robotRows = (
        await db.query<{ robot_id: string; product_name: string; status: RobotStatus; last_seen_at: Date | null; battery_pct: number | null; current_mission_name: string | null }>(
          `SELECT r.robot_id, p.name AS product_name, s.status, ls.last_seen_at, ls.battery_pct,
                  (SELECT cm.name FROM missions cm WHERE cm.mission_id = ls.current_mission_id) AS current_mission_name
           FROM robots r JOIN products p ON p.id = r.product_id JOIN v_robot_status s ON s.robot_id = r.robot_id
           LEFT JOIN live_state ls ON ls.robot_id = r.robot_id ${rw.toSql()} ORDER BY r.robot_id`,
          rw.params,
        )
      ).rows;

      const mw = missionWhere(user, null, start, end);
      const perRobot = new Map(
        (await db.query(`SELECT m.robot_id, ${STATS_SELECT} FROM missions m ${mw.toSql()} GROUP BY m.robot_id`, mw.params)).rows.map((r) => [r.robot_id as string, toStats(r)]),
      );
      const dw = missionWhere(user, null, start, end);
      const perDay = (await db.query(`SELECT (${MISSION_TIME} AT TIME ZONE 'Asia/Kolkata')::date::text AS d, ${STATS_SELECT} FROM missions m ${dw.toSql()} GROUP BY 1`, dw.params)).rows;

      const daily = new Map<string, FleetReportDto['daily'][number]>();
      for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) {
        const d = istDate(new Date(t));
        daily.set(d, { date: d, missions: 0, completed: 0, aborted: 0, failed: 0, distance_m: 0, driven_m: 0 });
      }
      for (const r of perDay) {
        const row = daily.get(r.d as string);
        if (!row) continue;
        const st = toStats(r);
        Object.assign(row, { missions: st.total, completed: st.completed, aborted: st.aborted, failed: st.failed, distance_m: st.distance_m });
      }

      const robotsOut: FleetReportDto['robots'] = [];
      for (const r of robotRows) {
        let driven = 0;
        let moving = 0;
        for (const d of await dailyDistance(user, r.robot_id, start, end)) {
          const m = d.odometer_m ?? d.wheel_m;
          driven += m;
          moving += d.moving_s;
          const row = daily.get(d.date);
          if (row) row.driven_m += m;
        }
        robotsOut.push({
          robot_id: r.robot_id,
          product_name: r.product_name,
          status: r.status,
          last_seen_at: iso(r.last_seen_at),
          battery_pct: r.battery_pct,
          current_mission_name: r.current_mission_name,
          missions: perRobot.get(r.robot_id) ?? toStats(undefined),
          driven_m: driven,
          moving_s: moving,
        });
      }
      const sum = (k: keyof MissionStatsDto) => robotsOut.reduce((n, r) => n + r.missions[k], 0);
      return {
        from: query.from,
        to: query.to,
        totals: {
          total: sum('total'),
          completed: sum('completed'),
          aborted: sum('aborted'),
          failed: sum('failed'),
          in_progress: sum('in_progress'),
          distance_m: sum('distance_m'),
          duration_s: sum('duration_s'),
          robots: robotsOut.length,
          online: robotsOut.filter((r) => r.status === 'online').length,
          driven_m: robotsOut.reduce((n, r) => n + r.driven_m, 0),
          moving_s: robotsOut.reduce((n, r) => n + r.moving_s, 0),
        },
        robots: robotsOut,
        daily: [...daily.values()],
      };
    },
  });
}
