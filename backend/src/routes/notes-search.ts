import type { Paginated, RobotNoteDto, SearchResultDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { notFound } from '../lib/errors';
import { anyScope, robotParam, robotVia, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { optionalBool, pageQuery } from '../lib/validation';

const NOTE_SELECT = `
SELECT n.id, n.robot_id, n.body, n.pinned, n.created_at, u.name AS created_by_name
FROM robot_notes n LEFT JOIN users u ON u.id = n.created_by`;
const toNote = (r: Record<string, unknown>): RobotNoteDto => ({ ...(r as unknown as RobotNoteDto), created_at: iso(r.created_at as Date)! });

/**
 * A robot's journal (0025): dated notes people add so that, years later, anyone can see what happened and why.
 * Notes are never edited; they can be pinned (shown first) or removed (kept, hidden). Arnobot staff only.
 * And the top bar's global search over robots, organizations and products.
 */
export function noteSearchRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const noteRobot = robotVia('SELECT robot_id FROM robot_notes WHERE id = $1', 'note');

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/notes',
    summary: "A robot's journal: pinned notes first, then newest first",
    tag: 'Robots',
    access: { can: 'robot.details', target: robotParam() },
    query: z.object({ q: z.string().trim().max(200).optional(), ...pageQuery }),
    handler: async ({ params, query }): Promise<Paginated<RobotNoteDto>> => {
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      const w = new Where().add('n.robot_id = ?', params.robotId).add('n.deleted_at IS NULL');
      if (query.q) w.add('n.body ILIKE ?', `%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
      return paginate(db, NOTE_SELECT, w, 'n.pinned DESC, n.created_at DESC', query.page, query.limit, toNote) as Promise<Paginated<RobotNoteDto>>;
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/robots/:robotId/notes',
    summary: 'Add a note to the journal',
    tag: 'Robots',
    access: { can: 'robot.write', target: robotParam() },
    body: z.object({ body: z.string().trim().min(1).max(10_000), pinned: optionalBool }),
    status: 201,
    handler: async ({ params, body, user, req }): Promise<RobotNoteDto> => {
      await app.robots.assertExists(params.robotId);
      const id = (
        await db.query<{ id: string }>('INSERT INTO robot_notes (robot_id, body, pinned, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [params.robotId, body.body, body.pinned ?? false, user.id])
      ).rows[0].id;
      await app.audit.record({ action: 'robot.note_added', actor: user, target: { type: 'robot_note', id }, robotId: params.robotId, req });
      return toNote((await db.query(`${NOTE_SELECT} WHERE n.id = $1`, [id])).rows[0]);
    },
  });

  route(f, app, {
    method: 'PATCH',
    path: '/notes/:id',
    summary: 'Pin or unpin a note',
    tag: 'Robots',
    access: { can: 'robot.write', target: noteRobot },
    body: z.object({ pinned: z.boolean() }),
    handler: async ({ params, body }): Promise<RobotNoteDto> => {
      const res = await db.query('UPDATE robot_notes SET pinned = $2 WHERE id = $1 AND deleted_at IS NULL', [params.id, body.pinned]);
      if (!res.rowCount) throw notFound('note');
      return toNote((await db.query(`${NOTE_SELECT} WHERE n.id = $1`, [params.id])).rows[0]);
    },
  });

  route(f, app, {
    method: 'DELETE',
    path: '/notes/:id',
    summary: 'Remove a note (kept, hidden; the removal is audited)',
    tag: 'Robots',
    access: { can: 'robot.write', target: noteRobot },
    handler: async ({ params, user, req }) => {
      const r = (await db.query<{ robot_id: string }>('UPDATE robot_notes SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING robot_id', [params.id, user.id])).rows[0];
      if (!r) throw notFound('note');
      await app.audit.record({ action: 'robot.note_removed', actor: user, target: { type: 'robot_note', id: params.id }, robotId: r.robot_id, req });
      return { ok: true };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/search',
    summary: 'Global search: robots (ID, nickname, serial number, owner, attachments), organizations and base models the user may see',
    tag: 'Meta',
    access: { can: 'robot.details', target: anyScope() },
    query: z.object({ q: z.string().trim().min(1).max(100) }),
    handler: async ({ query, user }): Promise<SearchResultDto> => {
      const like = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      const starts = `${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      const w = app.perms.applyRobotScope(new Where(), app.perms.robotScope(user, 'robot.read'), 'r.robot_id').add('r.deleted_at IS NULL');
      const p1 = w.param(like);
      const p2 = w.param(starts);
      w.add(
        `(r.robot_id ILIKE ${p1} OR r.serial_number ILIKE ${p1} OR r.nickname ILIKE ${p1} OR r.description ILIKE ${p1} OR c.name ILIKE ${p1} OR p.name ILIKE ${p1}
          OR EXISTS (SELECT 1 FROM robot_attachments qa JOIN attachments qx ON qx.id = qa.attachment_id WHERE qa.robot_id = r.robot_id AND qa.removed_at IS NULL AND qx.name ILIKE ${p1}))`,
      );
      const robots = (
        await db.query(
          `SELECT r.robot_id, r.nickname, r.serial_number, p.name AS product_name, p.category, c.name AS owner_company,
                  coalesce((SELECT array_agg(a.name ORDER BY a.name) FROM robot_attachments ra JOIN attachments a ON a.id = ra.attachment_id
                            WHERE ra.robot_id = r.robot_id AND ra.removed_at IS NULL), '{}') AS attachments
           FROM robots r JOIN products p ON p.id = r.product_id
           LEFT JOIN company_assignment_history o ON o.robot_id = r.robot_id AND o.valid_to IS NULL LEFT JOIN companies c ON c.id = o.company_id
           ${w.toSql()} ORDER BY (r.robot_id ILIKE ${p2} OR r.nickname ILIKE ${p2}) DESC, r.product_id, r.running_number LIMIT 8`,
          w.params,
        )
      ).rows as SearchResultDto['robots'];
      const organizations = (await app.perms.can(user, 'org.manage', { type: 'platform' }))
        ? ((await db.query(`SELECT id, name, kind FROM companies WHERE deleted_at IS NULL AND name ILIKE $1 ORDER BY name LIMIT 5`, [like])).rows as SearchResultDto['organizations'])
        : [];
      const products = (await app.perms.can(user, 'catalog.read', { type: 'platform' }))
        ? ((await db.query(`SELECT id, name, code, category FROM products WHERE deleted_at IS NULL AND (name ILIKE $1 OR code ILIKE $1) ORDER BY name LIMIT 5`, [like])).rows as SearchResultDto['products'])
        : [];
      return { robots, organizations, products };
    },
  });
}
