import { EVENT_SEVERITIES, EVENT_TYPES, type EventDto, type Paginated } from '@arnobot/message-schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { conflict } from '../lib/errors';
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
    access: { can: 'robot.read', target: anyScope() },
    query: listQuery,
    handler: ({ query, user }) => list(query, app.perms.applyRobotScope(new Where(), app.perms.robotScope(user, 'robot.read'), 'e.robot_id')),
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/events',
    summary: 'Events of one robot',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    query: listQuery,
    handler: async ({ params, query }) => {
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      return list({ ...query, robot: undefined }, new Where().add('e.robot_id = ?', params.robotId));
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/events/:id/ack',
    summary: 'Acknowledge one event (records who and when)',
    tag,
    access: { can: 'event.ack', target: robotVia('SELECT robot_id FROM events WHERE id = $1', 'event') },
    handler: async ({ params, user }) => {
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
      app.perms.applyRobotScope(w, app.perms.robotScope(user, 'event.ack'), 'e.robot_id');
      const res = await db.query(`UPDATE events e SET acknowledged_by = ${w.param(user.id)}, acknowledged_at = now() ${w.toSql()}`, w.params);
      return { acknowledged: res.rowCount ?? 0 };
    },
  });
}
