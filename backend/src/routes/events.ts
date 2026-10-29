import { EVENT_SEVERITIES, EVENT_TYPES, type ActiveFaultDto, type EventCalendarDayDto, type EventDto, type Paginated } from '../shared';
import type { Queryable } from '../db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { conflict, notFound } from '../lib/errors';
import { anyScope, robotParam, robotVia, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { isoDateTime, optionalBool, pageQuery, robotIdSchema, uuidSchema } from '../lib/validation';

export const EVENT_SELECT = `
SELECT e.id, e.msg_id, e.robot_id, e.ts, e.type, e.severity, e.code, e.message, e.data,
       u.name AS acknowledged_by_name, e.acknowledged_at, e.received_at
FROM events e LEFT JOIN users u ON u.id = e.acknowledged_by`;
export const toEvent = (r: Record<string, unknown>): EventDto => ({
  ...(r as unknown as EventDto),
  ts: iso(r.ts as Date)!,
  acknowledged_at: iso(r.acknowledged_at as Date | null),
  received_at: iso(r.received_at as Date)!,
});
/** Which device a fault code concerns (robot and GCS codes: GIGA_NOT_CONNECTED, LIDAR_NOT_AVAILABLE, NO_GPS, BMS_FAULT …). */
export function faultDevice(code: string): ActiveFaultDto['device'] {
  const c = code.toUpperCase();
  if (/LIDAR/.test(c)) return 'lidar';
  if (/CAM|RTSP|DVR/.test(c)) return 'cameras';
  if (/GPS|GNSS|RTK/.test(c)) return 'gps';
  if (/BATTERY|BMS|VOLT/.test(c)) return 'battery';
  if (/GIGA|CONTROLLER|MOTOR|ESTOP|EMERGENCY|JETSON|TEMP/.test(c)) return 'controller';
  return 'other';
}

/**
 * Faults and alerts still active: for each robot and code, the latest event decides. Robots send an `info`
 * "… cleared" event when a problem ends, so the code is active while its latest event is a warning or critical.
 * `w` carries the caller's robot / data scope on `e.robot_id` and `e.ts`.
 */
export async function activeFaults(db: Queryable, w: Where): Promise<ActiveFaultDto[]> {
  w.add('e.code IS NOT NULL').add("e.type IN ('fault', 'alert')").add('EXISTS (SELECT 1 FROM robots rr WHERE rr.robot_id = e.robot_id AND rr.deleted_at IS NULL)');
  const rows = await db.query<{ id: string; robot_id: string; code: string; severity: ActiveFaultDto['severity']; message: string; ts: Date; acknowledged_at: Date | null }>(
    `SELECT x.* FROM (
       SELECT DISTINCT ON (e.robot_id, e.code) e.id, e.robot_id, e.code, e.severity, e.message, e.ts, e.acknowledged_at
       FROM events e ${w.toSql()} ORDER BY e.robot_id, e.code, e.ts DESC
     ) x WHERE x.severity <> 'info' ORDER BY (x.severity = 'critical') DESC, x.ts DESC`,
    w.params,
  );
  return rows.rows.map((r) => ({
    event_id: r.id,
    robot_id: r.robot_id,
    code: r.code,
    device: faultDevice(r.code),
    severity: r.severity,
    message: r.message,
    since: iso(r.ts)!,
    acknowledged_at: iso(r.acknowledged_at),
  }));
}

const listQuery = z.object({
  robot: robotIdSchema.optional(),
  type: z.enum(EVENT_TYPES).optional(),
  severity: z.enum(EVENT_SEVERITIES).optional(),
  unacked: optionalBool,
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  ...pageQuery,
});

/** Event log (spec §3 row 13): append-only; acknowledgement is the only change allowed. */
export function eventRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Events';

  const list = (q: z.infer<typeof listQuery>, w: Where): Promise<Paginated<EventDto>> => {
    if (q.robot) w.add('e.robot_id = ?', q.robot);
    if (q.type) w.add('e.type = ?', q.type);
    if (q.severity) w.add('e.severity = ?', q.severity);
    if (q.unacked) w.add('e.acknowledged_at IS NULL');
    if (q.from) w.add('e.ts >= ?', q.from);
    if (q.to) w.add('e.ts < ?', q.to);
    return paginate(db, EVENT_SELECT, w, 'e.ts DESC, e.id', q.page, q.limit, toEvent) as Promise<Paginated<EventDto>>;
  };

  route(f, app, {
    method: 'GET',
    path: '/events',
    summary: 'Event log across robots the user may read',
    tag,
    access: { can: 'robot.details', target: anyScope() },
    query: listQuery,
    handler: ({ query, user }) => list(query, app.perms.applyDataScope(new Where(), app.perms.robotScope(user, 'robot.details'), 'e.robot_id', 'e.ts')),
  });

  route(f, app, {
    method: 'GET',
    path: '/events/calendar',
    summary: 'Events across robots the user may read, counted per IST day of a month (total, critical, warning, unacknowledged)',
    tag,
    access: { can: 'robot.details', target: anyScope() },
    query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM') }),
    handler: async ({ query, user }): Promise<EventCalendarDayDto[]> => {
      const [y, m] = query.month.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      const w = app.perms.applyDataScope(new Where(), app.perms.robotScope(user, 'robot.details'), 'e.robot_id', 'e.ts');
      w.add('e.ts >= ?', `${query.month}-01T00:00:00+05:30`).add('e.ts < ?', `${next}-01T00:00:00+05:30`);
      const rows = await db.query<EventCalendarDayDto>(
        `SELECT (e.ts AT TIME ZONE 'Asia/Kolkata')::date::text AS date, count(*)::int AS total,
                count(*) FILTER (WHERE e.severity = 'critical')::int AS critical,
                count(*) FILTER (WHERE e.severity = 'warning')::int AS warning,
                count(*) FILTER (WHERE e.acknowledged_at IS NULL)::int AS unacked
         FROM events e ${w.toSql()} GROUP BY 1 ORDER BY 1`,
        w.params,
      );
      return rows.rows;
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/faults',
    summary: "One robot's faults and alerts that are still active (latest event per code is not cleared)",
    tag,
    access: { can: 'robot.details', target: robotParam() },
    handler: async ({ params, user }): Promise<ActiveFaultDto[]> => {
      const w = app.perms.applyDataScope(new Where(), app.perms.robotScope(user, 'robot.details'), 'e.robot_id', 'e.ts').add('e.robot_id = ?', params.robotId);
      return activeFaults(db, w);
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/events',
    summary: 'Events of one robot',
    tag,
    access: { can: 'robot.details', target: robotParam() },
    query: listQuery,
    handler: async ({ params, query, user }) => {
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      const w = new Where().add('e.robot_id = ?', params.robotId);
      return list({ ...query, robot: undefined }, app.perms.applyDataScope(w, app.perms.robotScope(user, 'robot.details'), 'e.robot_id', 'e.ts'));
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/events/:id/ack',
    summary: 'Acknowledge one event (records who and when)',
    tag,
    access: { can: 'event.ack', target: robotVia('SELECT robot_id FROM events WHERE id = $1', 'event') },
    handler: async ({ params, user }) => {
      const ev = (await db.query<{ robot_id: string; ts: Date }>('SELECT robot_id, ts FROM events WHERE id = $1', [params.id])).rows[0];
      if (!(await app.perms.canSeeData(user, 'event.ack', ev.robot_id, ev.ts))) throw notFound('event');
      const res = await db.query('UPDATE events SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL', [params.id, user.id]);
      if (!res.rowCount) throw conflict('event is already acknowledged');
      return toEvent((await db.query(`${EVENT_SELECT} WHERE e.id = $1`, [params.id])).rows[0]);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/events/ack',
    summary: 'Acknowledge several events; only events on robots the user may acknowledge are changed',
    tag,
    access: { can: 'event.ack', target: anyScope() },
    body: z.object({ ids: z.array(uuidSchema).min(1).max(500) }),
    handler: async ({ body, user }) => {
      const w = new Where().add('e.id = ANY(?::uuid[])', body.ids).add('e.acknowledged_at IS NULL');
      app.perms.applyDataScope(w, app.perms.robotScope(user, 'event.ack'), 'e.robot_id', 'e.ts');
      const res = await db.query(`UPDATE events e SET acknowledged_by = ${w.param(user.id)}, acknowledged_at = now() ${w.toSql()}`, w.params);
      return { acknowledged: res.rowCount ?? 0 };
    },
  });
}
