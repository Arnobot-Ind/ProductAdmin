import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { anyScope, route } from '../lib/route';
import { iso, Where } from '../lib/sql';
import type { FleetActivityDayDto, FleetDayActivityDto, RobotCategory, RobotDayActivityDto } from '../shared';

/**
 * Activity page: what the fleet did, day by day (IST). The calendar counts per day; a day lists every robot that did
 * something (missions, distance, run time, alerts, recordings, software updates, repairs, part changes).
 * Only robots and data the user may read (robot.details, with a customer's data period).
 */
const monthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM') });
const dayQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD') });
const DAY = (col: string) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date::text`;

const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const nextDay = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function activityRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Activity';

  /** A WHERE limited to the user's robots and data period, plus [from, to) on the given time column. */
  const scoped = (user: Parameters<typeof app.perms.robotScope>[0], robotCol: string, timeCol: string, from: string, to: string) =>
    app.perms
      .applyDataScope(new Where(), app.perms.robotScope(user, 'robot.details'), robotCol, timeCol)
      .add(`${timeCol} >= ?`, from)
      .add(`${timeCol} < ?`, to)
      .add(`EXISTS (SELECT 1 FROM robots rr WHERE rr.robot_id = ${robotCol} AND rr.deleted_at IS NULL)`);

  route(f, app, {
    method: 'GET',
    path: '/activity/calendar',
    summary: 'Fleet activity per IST day of a month: active robots, missions, distance, alerts',
    tag,
    access: { can: 'robot.details', target: anyScope() },
    query: monthQuery,
    handler: async ({ query, user }): Promise<FleetActivityDayDto[]> => {
      const from = `${query.month}-01T00:00:00+05:30`;
      const to = `${nextMonth(query.month)}-01T00:00:00+05:30`;
      const wm = scoped(user, 'm.robot_id', 'coalesce(m.started_at, m.created_at)', from, to);
      const we = scoped(user, 'e.robot_id', 'e.ts', from, to);
      const ws = scoped(user, 's.robot_id', 'coalesce(s.started_at, s.created_at)', from, to).add('s.deleted_at IS NULL');
      const [mis, ev, ...pairs] = await Promise.all([
        db.query<{ d: string; n: number; bad: number; m: number }>(
          `SELECT ${DAY('coalesce(m.started_at, m.created_at)')} AS d, count(*)::int AS n,
                  count(*) FILTER (WHERE m.result IN ('failed', 'aborted'))::int AS bad, coalesce(sum(m.distance_m), 0)::float AS m
           FROM missions m ${wm.toSql()} GROUP BY 1`,
          wm.params,
        ),
        db.query<{ d: string; crit: number; warn: number }>(
          `SELECT ${DAY('e.ts')} AS d, count(*) FILTER (WHERE e.severity = 'critical')::int AS crit, count(*) FILTER (WHERE e.severity = 'warning')::int AS warn
           FROM events e ${we.toSql()} GROUP BY 1`,
          we.params,
        ),
        // Robots active per day: a mission, an event or a recording (counted once, below).
        db.query<{ d: string; r: string }>(`SELECT DISTINCT ${DAY('coalesce(m.started_at, m.created_at)')} AS d, m.robot_id AS r FROM missions m ${wm.toSql()}`, wm.params),
        db.query<{ d: string; r: string }>(`SELECT DISTINCT ${DAY('e.ts')} AS d, e.robot_id AS r FROM events e ${we.toSql()}`, we.params),
        db.query<{ d: string; r: string }>(`SELECT DISTINCT ${DAY('coalesce(s.started_at, s.created_at)')} AS d, s.robot_id AS r FROM archive_sessions s ${ws.toSql()}`, ws.params),
      ]);
      const days = new Map<string, FleetActivityDayDto>();
      const day = (d: string) => {
        let row = days.get(d);
        if (!row) days.set(d, (row = { date: d, robots: 0, missions: 0, missions_bad: 0, driven_m: 0, alerts_critical: 0, alerts_warning: 0 }));
        return row;
      };
      for (const r of mis.rows) Object.assign(day(r.d), { missions: r.n, missions_bad: r.bad, driven_m: Math.round(r.m) });
      for (const r of ev.rows) Object.assign(day(r.d), { alerts_critical: r.crit, alerts_warning: r.warn });
      const active = new Map<string, Set<string>>();
      for (const q of pairs) for (const p of q.rows) (active.get(p.d) ?? active.set(p.d, new Set()).get(p.d)!).add(p.r);
      for (const [d, set] of active) day(d).robots = set.size;
      return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/activity/day',
    summary: 'What every robot did on one IST day: missions, distance, run time, alerts, recordings, software updates, repairs',
    tag,
    access: { can: 'robot.details', target: anyScope() },
    query: dayQuery,
    handler: async ({ query, user }): Promise<FleetDayActivityDto> => {
      const from = `${query.date}T00:00:00+05:30`;
      const to = `${nextDay(query.date)}T00:00:00+05:30`;
      const wm = scoped(user, 'm.robot_id', 'coalesce(m.started_at, m.created_at)', from, to);
      const we = scoped(user, 'e.robot_id', 'e.ts', from, to);
      const wp = scoped(user, 'e.robot_id', 'e.ts', from, to).add("e.severity IN ('warning', 'critical')");
      const ws = scoped(user, 's.robot_id', 'coalesce(s.started_at, s.created_at)', from, to).add('s.deleted_at IS NULL');
      const wsw = scoped(user, 'h.robot_id', 'h.reported_at', from, to);
      const wr = scoped(user, 'l.robot_id', 'l.repaired_at::timestamp AT TIME ZONE \'Asia/Kolkata\'', from, to).add('l.deleted_at IS NULL');
      const whf = scoped(user, 'p.robot_id', "p.fitted_at::timestamp AT TIME ZONE 'Asia/Kolkata'", from, to);
      const whr = scoped(user, 'p.robot_id', "p.removed_at::timestamp AT TIME ZONE 'Asia/Kolkata'", from, to);
      const [mis, ev, probs, rec, sw, rep, fit, rem] = await Promise.all([
        db.query<{ r: string; n: number; ok: number; ab: number; fail: number; open: number; m: number; s: number; first: Date | null; last: Date | null }>(
          `SELECT m.robot_id AS r, count(*)::int AS n,
                  count(*) FILTER (WHERE m.result = 'completed')::int AS ok, count(*) FILTER (WHERE m.result = 'aborted')::int AS ab,
                  count(*) FILTER (WHERE m.result = 'failed')::int AS fail, count(*) FILTER (WHERE m.result IS NULL)::int AS open,
                  coalesce(sum(m.distance_m), 0)::float AS m,
                  coalesce(sum(coalesce(m.duration_s, extract(epoch FROM m.ended_at - m.started_at))), 0)::float AS s,
                  min(m.started_at) AS first, max(m.ended_at) AS last
           FROM missions m ${wm.toSql()} GROUP BY 1`,
          wm.params,
        ),
        db.query<{ r: string; crit: number; warn: number }>(
          `SELECT e.robot_id AS r, count(*) FILTER (WHERE e.severity = 'critical')::int AS crit, count(*) FILTER (WHERE e.severity = 'warning')::int AS warn
           FROM events e ${we.toSql()} GROUP BY 1`,
          we.params,
        ),
        db.query<{ r: string; code: string | null; type: string; severity: 'warning' | 'critical'; message: string; n: number }>(
          `SELECT r, code, type, severity, message, n FROM (
             SELECT e.robot_id AS r, e.code, max(e.type) AS type,
                    CASE WHEN bool_or(e.severity = 'critical') THEN 'critical' ELSE 'warning' END AS severity,
                    (array_agg(e.message ORDER BY e.ts DESC))[1] AS message, count(*)::int AS n,
                    row_number() OVER (PARTITION BY e.robot_id ORDER BY count(*) DESC) AS k
             FROM events e ${wp.toSql()} GROUP BY e.robot_id, e.code, coalesce(e.code, e.message)
           ) x WHERE k <= 5 ORDER BY r, n DESC`,
          wp.params,
        ),
        db.query<{ r: string; n: number }>(`SELECT s.robot_id AS r, count(*)::int AS n FROM archive_sessions s ${ws.toSql()} GROUP BY 1`, ws.params),
        db.query<{ r: string; sw_ver: string | null; fw_ver: string | null; at: Date }>(
          `SELECT h.robot_id AS r, h.sw_ver, h.fw_ver, h.reported_at AS at FROM software_history h ${wsw.toSql()} ORDER BY h.reported_at`,
          wsw.params,
        ),
        db.query<{ r: string; description: string; repaired_by: string }>(
          `SELECT l.robot_id AS r, l.description, l.repaired_by FROM maintenance_log l ${wr.toSql()} ORDER BY l.created_at`,
          wr.params,
        ),
        db.query<{ r: string; n: number }>(`SELECT p.robot_id AS r, count(*)::int AS n FROM hardware_fitted p ${whf.toSql()} GROUP BY 1`, whf.params),
        db.query<{ r: string; n: number }>(`SELECT p.robot_id AS r, count(*)::int AS n FROM hardware_fitted p ${whr.toSql()} GROUP BY 1`, whr.params),
      ]);

      const ids = new Set<string>();
      for (const q of [mis, ev, rec, sw, rep, fit, rem]) for (const row of q.rows as { r: string }[]) ids.add(row.r);
      const info = ids.size
        ? (
            await db.query<{ robot_id: string; nickname: string | null; product_name: string; category: RobotCategory; owner_company: string | null }>(
              `SELECT r.robot_id, r.nickname, p.name AS product_name, p.category, c.name AS owner_company
               FROM robots r JOIN products p ON p.id = r.product_id
               LEFT JOIN company_assignment_history o ON o.robot_id = r.robot_id AND o.valid_to IS NULL
               LEFT JOIN companies c ON c.id = o.company_id
               WHERE r.robot_id = ANY($1::text[])`,
              [[...ids]],
            )
          ).rows
        : [];

      const robots = new Map<string, RobotDayActivityDto>();
      for (const i of info) {
        robots.set(i.robot_id, {
          ...i,
          missions: 0, completed: 0, aborted: 0, failed: 0, in_progress: 0, driven_m: 0, run_s: 0, first_at: null, last_at: null,
          alerts_critical: 0, alerts_warning: 0, problems: [], recordings: 0, software: [], repairs: [], parts_changed: 0,
        });
      }
      const get = (id: string) => robots.get(id);
      for (const m of mis.rows) {
        const x = get(m.r);
        if (x) Object.assign(x, { missions: m.n, completed: m.ok, aborted: m.ab, failed: m.fail, in_progress: m.open, driven_m: Math.round(m.m), run_s: Math.round(m.s), first_at: iso(m.first), last_at: iso(m.last) });
      }
      for (const e of ev.rows) {
        const x = get(e.r);
        if (x) Object.assign(x, { alerts_critical: e.crit, alerts_warning: e.warn });
      }
      for (const p of probs.rows) get(p.r)?.problems.push({ code: p.code, type: p.type, severity: p.severity, message: p.message, count: p.n });
      for (const r of rec.rows) {
        const x = get(r.r);
        if (x) x.recordings = r.n;
      }
      for (const s of sw.rows) get(s.r)?.software.push({ sw_ver: s.sw_ver, fw_ver: s.fw_ver, at: iso(s.at)! });
      for (const r of rep.rows) get(r.r)?.repairs.push({ description: r.description, repaired_by: r.repaired_by });
      for (const q of [fit, rem]) {
        for (const r of q.rows) {
          const x = get(r.r);
          if (x) x.parts_changed += r.n;
        }
      }

      // Busiest first: missions, then distance, then alerts.
      const list = [...robots.values()].sort((a, b) => b.missions - a.missions || b.driven_m - a.driven_m || b.alerts_critical - a.alerts_critical || a.robot_id.localeCompare(b.robot_id));
      const sum = (k: 'missions' | 'driven_m' | 'run_s' | 'alerts_critical' | 'alerts_warning') => list.reduce((s, r) => s + r[k], 0);
      return {
        date: query.date,
        robots: list,
        totals: {
          robots: list.length,
          missions: sum('missions'),
          missions_bad: list.reduce((s, r) => s + r.aborted + r.failed, 0),
          driven_m: sum('driven_m'),
          run_s: sum('run_s'),
          alerts_critical: sum('alerts_critical'),
          alerts_warning: sum('alerts_warning'),
        },
      };
    },
  });
}
