import { withTransaction } from '../db';
import { ROBOT_CATEGORIES, type AttachmentDetailDto, type AttachmentDto, type RobotAttachmentDto, type RobotDirectoryEntryDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { anyScope, platform, robotParam, robotVia, route } from '../lib/route';
import { iso, Where } from '../lib/sql';
import { assertUuid, includeDeleted, isoDateTime, nullableText, optionalBool, repoUrlField, uuidSchema } from '../lib/validation';
import { hardwareRevisions } from './catalogue';

const ATTACHMENT_SELECT = `
SELECT a.id, a.name, a.category, a.description, a.manufacturer, a.model_number, a.repo_url, a.created_at, a.deleted_at,
       (SELECT pm.id FROM product_media pm WHERE pm.attachment_id = a.id AND pm.kind = 'photo' AND pm.deleted_at IS NULL ORDER BY pm.created_at LIMIT 1) AS cover_photo_id,
       (SELECT pm.id FROM product_media pm WHERE pm.attachment_id = a.id AND pm.kind = 'model_3d' AND pm.deleted_at IS NULL ORDER BY pm.created_at DESC LIMIT 1) AS model_3d_id,
       (SELECT count(*)::int FROM product_media pm WHERE pm.attachment_id = a.id AND pm.kind = 'photo' AND pm.deleted_at IS NULL) AS photo_count,
       (SELECT count(*)::int FROM product_media pm WHERE pm.attachment_id = a.id AND pm.kind = 'spin' AND pm.deleted_at IS NULL) AS spin_count,
       (SELECT count(*)::int FROM hardware_revisions h WHERE h.attachment_id = a.id AND h.deleted_at IS NULL) AS revision_count,
       (SELECT count(*)::int FROM robot_attachments ra JOIN robots r ON r.robot_id = ra.robot_id
        WHERE ra.attachment_id = a.id AND ra.removed_at IS NULL AND r.deleted_at IS NULL) AS robot_count
FROM attachments a`;
const toAttachment = (r: Record<string, unknown>): AttachmentDto => ({ ...(r as unknown as AttachmentDto), created_at: iso(r.created_at as Date)!, deleted_at: iso(r.deleted_at as Date | null) });

const FITTING_SELECT = `
SELECT ra.id, ra.robot_id, ra.attachment_id, a.name, a.description, ra.hardware_revision_id, h.name AS revision_name, ra.serial_number,
       ra.fitted_at, fu.name AS fitted_by_name, ra.notes, ra.removed_at, ru.name AS removed_by_name, ra.removal_note
FROM robot_attachments ra JOIN attachments a ON a.id = ra.attachment_id
LEFT JOIN hardware_revisions h ON h.id = ra.hardware_revision_id
LEFT JOIN users fu ON fu.id = ra.fitted_by LEFT JOIN users ru ON ru.id = ra.removed_by`;
const toFitting = (r: Record<string, unknown>): RobotAttachmentDto => ({
  ...(r as unknown as RobotAttachmentDto),
  fitted_at: iso(r.fitted_at as Date)!,
  removed_at: iso(r.removed_at as Date | null),
});

const attachmentBody = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.enum(ROBOT_CATEGORIES).nullable().optional(),
  description: nullableText(500).optional(),
  manufacturer: nullableText(100).optional(),
  model_number: nullableText(100).optional(),
  repo_url: repoUrlField.optional(),
});

/**
 * Attachments (0025): a catalogue of equipment that can be fitted on a vehicle, and per robot the history of what
 * was fitted and removed when (which revision, which unit). An attachment keeps the same records as a base model:
 * photos / 3D, hardware revisions and documents (those routes are with the base model's, in catalogue.ts). Plus the robot directory: every robot in a few words (ID, nickname, base model,
 * attachments), which the admin panel shows wherever a robot ID appears.
 */
export function attachmentRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Catalogue';
  const read = { can: 'catalog.read', target: anyScope() };
  const write = { can: 'catalog.write', target: platform() };
  const fittingRobot = robotVia('SELECT robot_id FROM robot_attachments WHERE id = $1', 'attachment fitting');

  const byId = async (id: string) => {
    assertUuid(id);
    const r = (await db.query(`${ATTACHMENT_SELECT} WHERE a.id = $1`, [id])).rows[0];
    if (!r) throw notFound('attachment');
    return toAttachment(r);
  };

  route(f, app, {
    method: 'GET',
    path: '/attachments',
    summary: 'Attachment catalogue (equipment that can be fitted on a vehicle)',
    tag,
    access: read,
    query: z.object(includeDeleted),
    handler: async ({ query }): Promise<AttachmentDto[]> =>
      (await db.query(`${ATTACHMENT_SELECT} ${query.include_deleted ? '' : 'WHERE a.deleted_at IS NULL'} ORDER BY a.deleted_at NULLS FIRST, lower(a.name)`)).rows.map(toAttachment),
  });

  route(f, app, {
    method: 'GET',
    path: '/attachments/:id',
    summary: 'An attachment with its hardware revisions and their main components',
    tag,
    access: read,
    query: z.object({ include_deleted: optionalBool }),
    handler: async ({ params, query }): Promise<AttachmentDetailDto> => ({
      ...(await byId(params.id)),
      revisions: await hardwareRevisions(`WHERE h.attachment_id = $1 ${query.include_deleted ? '' : 'AND h.deleted_at IS NULL'}`, [params.id], db),
    }),
  });

  route(f, app, {
    method: 'GET',
    path: '/attachments/:id/fittings',
    summary: 'Every robot this attachment is or was fitted on (fitted now first), limited to the robots the user may see',
    tag: 'Robots',
    access: { can: 'robot.details', target: anyScope() },
    handler: async ({ params, user }): Promise<RobotAttachmentDto[]> => {
      await byId(params.id);
      const w = app.perms.applyRobotScope(new Where(), app.perms.robotScope(user, 'robot.read'), 'ra.robot_id');
      w.add('ra.attachment_id = ?', params.id);
      return (await db.query(`${FITTING_SELECT} ${w.toSql()} ORDER BY (ra.removed_at IS NULL) DESC, coalesce(ra.removed_at, ra.fitted_at) DESC LIMIT 2000`, w.params)).rows.map(toFitting);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/attachments',
    summary: 'Add an attachment to the catalogue',
    tag,
    access: write,
    body: attachmentBody,
    status: 201,
    handler: async ({ body, user }) => {
      if ((await db.query('SELECT 1 FROM attachments WHERE lower(name) = lower($1) AND deleted_at IS NULL', [body.name])).rowCount) throw conflict(`an attachment named ${body.name} already exists`);
      const id = (
        await db.query<{ id: string }>('INSERT INTO attachments (name, category, description, manufacturer, model_number, repo_url, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [
          body.name,
          body.category ?? null,
          body.description ?? null,
          body.manufacturer ?? null,
          body.model_number ?? null,
          body.repo_url ?? null,
          user.id,
        ])
      ).rows[0].id;
      return byId(id);
    },
  });

  route(f, app, {
    method: 'PATCH',
    path: '/attachments/:id',
    summary: 'Rename an attachment or change what it fits, its description, maker, model number or software repository',
    tag,
    access: write,
    body: attachmentBody.partial().strict(),
    handler: async ({ params, body }) => {
      const before = await byId(params.id);
      if (body.name && body.name.toLowerCase() !== before.name.toLowerCase()) {
        if ((await db.query('SELECT 1 FROM attachments WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> $2', [body.name, params.id])).rowCount) throw conflict(`an attachment named ${body.name} already exists`);
      }
      for (const k of ['name', 'category', 'description', 'manufacturer', 'model_number', 'repo_url'] as const) {
        if (body[k] !== undefined) await db.query(`UPDATE attachments SET ${k} = $2 WHERE id = $1`, [params.id, body[k]]);
      }
      return byId(params.id);
    },
  });

  for (const deleted of [true, false]) {
    route(f, app, {
      method: deleted ? 'DELETE' : 'POST',
      path: deleted ? '/attachments/:id' : '/attachments/:id/restore',
      summary: deleted ? 'Retire an attachment (only when no robot has it fitted; history is kept)' : 'Bring a retired attachment back',
      tag,
      access: write,
      handler: async ({ params }) => {
        const a = await byId(params.id);
        if (deleted && a.robot_count) throw conflict(`${a.name} is still fitted on ${a.robot_count} robot(s); remove it from them first`);
        const res = await db.query(`UPDATE attachments SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
        if (!res.rowCount) throw conflict(deleted ? 'already retired' : 'not retired');
        return byId(params.id);
      },
    });
  }

  // ── per robot ────────────────────────────────────────────────────────────
  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/attachments',
    summary: "A robot's attachments: fitted now first, then the history of removed ones",
    tag: 'Robots',
    access: { can: 'robot.details', target: robotParam() },
    handler: async ({ params }): Promise<RobotAttachmentDto[]> => {
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      return (await db.query(`${FITTING_SELECT} WHERE ra.robot_id = $1 ORDER BY (ra.removed_at IS NULL) DESC, coalesce(ra.removed_at, ra.fitted_at) DESC`, [params.robotId])).rows.map(toFitting);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/robots/:robotId/attachments',
    summary: 'Fit an attachment on a robot',
    tag: 'Robots',
    access: { can: 'robot.write', target: robotParam() },
    body: z.object({
      attachment_id: uuidSchema,
      hardware_revision_id: uuidSchema.nullable().optional(),
      serial_number: nullableText(100).optional(),
      fitted_at: isoDateTime.optional(),
      notes: nullableText(500).optional(),
    }),
    status: 201,
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        await app.robots.assertExists(params.robotId, {}, tx);
        const a = (await tx.query<{ name: string }>('SELECT name FROM attachments WHERE id = $1 AND deleted_at IS NULL', [body.attachment_id])).rows[0];
        if (!a) throw notFound('attachment');
        if ((await tx.query('SELECT 1 FROM robot_attachments WHERE robot_id = $1 AND attachment_id = $2 AND removed_at IS NULL', [params.robotId, body.attachment_id])).rowCount) {
          throw conflict(`${a.name} is already fitted on ${params.robotId}`);
        }
        if (body.fitted_at && new Date(body.fitted_at) > new Date()) throw badRequest('fitted_at is in the future');
        if (body.hardware_revision_id && !(await tx.query('SELECT 1 FROM hardware_revisions WHERE id = $1 AND attachment_id = $2 AND deleted_at IS NULL', [body.hardware_revision_id, body.attachment_id])).rowCount) {
          throw badRequest(`that revision is not a revision of ${a.name}`);
        }
        const id = (
          await tx.query<{ id: string }>(
            `INSERT INTO robot_attachments (robot_id, attachment_id, hardware_revision_id, serial_number, fitted_at, fitted_by, notes)
             VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6, $7) RETURNING id`,
            [params.robotId, body.attachment_id, body.hardware_revision_id ?? null, body.serial_number ?? null, body.fitted_at ?? null, user.id, body.notes ?? null],
          )
        ).rows[0].id;
        return toFitting((await tx.query(`${FITTING_SELECT} WHERE ra.id = $1`, [id])).rows[0]);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/robot-attachments/:id/remove',
    summary: 'Remove an attachment from a robot (the fitting stays in its history)',
    tag: 'Robots',
    access: { can: 'robot.write', target: fittingRobot },
    body: z.object({ note: nullableText(500).optional() }),
    handler: async ({ params, body, user }) => {
      const res = await db.query('UPDATE robot_attachments SET removed_at = now(), removed_by = $2, removal_note = $3 WHERE id = $1 AND removed_at IS NULL', [params.id, user.id, body.note ?? null]);
      if (!res.rowCount) throw conflict('already removed');
      return toFitting((await db.query(`${FITTING_SELECT} WHERE ra.id = $1`, [params.id])).rows[0]);
    },
  });

  // ── directory ────────────────────────────────────────────────────────────
  route(f, app, {
    method: 'GET',
    path: '/robots/directory',
    summary: 'Every robot the user may see in a few words: nickname, base model, category, attachments, owner (admin panel labels)',
    tag: 'Robots',
    access: { can: 'robot.details', target: anyScope() },
    handler: async ({ user, reply }): Promise<RobotDirectoryEntryDto[]> => {
      const w = app.perms.applyRobotScope(new Where(), app.perms.robotScope(user, 'robot.read'), 'r.robot_id');
      const rows = await db.query(
        `SELECT r.robot_id, r.nickname, r.description, p.name AS product_name, p.category, c.name AS owner_company,
                coalesce((SELECT array_agg(a.name ORDER BY a.name) FROM robot_attachments ra JOIN attachments a ON a.id = ra.attachment_id
                          WHERE ra.robot_id = r.robot_id AND ra.removed_at IS NULL), '{}') AS attachments
         FROM robots r JOIN products p ON p.id = r.product_id
         LEFT JOIN company_assignment_history o ON o.robot_id = r.robot_id AND o.valid_to IS NULL LEFT JOIN companies c ON c.id = o.company_id
         ${w.toSql()} ORDER BY r.product_id, r.running_number`,
        w.params,
      );
      reply.header('Cache-Control', 'private, max-age=60');
      return rows.rows as RobotDirectoryEntryDto[];
    },
  });
}
