import { withTransaction } from '@arnobot/db';
import { DOCUMENT_TYPES, type DocumentDto } from '@arnobot/message-schema';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { robotFromBody, robotParam, robotVia, route, type TargetResolver } from '../lib/route';
import { assertUuid, optionalBool, optionalText, robotIdSchema, uuidSchema } from '../lib/validation';

const createFields = z
  .object({
    doc_type: z.enum(DOCUMENT_TYPES),
    title: z.string().trim().min(1).max(300),
    product_id: uuidSchema.optional().or(z.literal('').transform(() => undefined)),
    hardware_revision_id: uuidSchema.optional().or(z.literal('').transform(() => undefined)),
    robot_id: robotIdSchema.optional().or(z.literal('').transform(() => undefined)),
    note: optionalText(1000),
  })
  .refine((v) => [v.product_id, v.hardware_revision_id, v.robot_id].filter(Boolean).length === 1, {
    message: 'attach the document to exactly one of product_id, hardware_revision_id or robot_id',
  });
const versionFields = z.object({ note: optionalText(1000) });

/**
 * Download permission: a robot's own document needs robot.read on that robot; product / revision
 * documentation is readable by anyone who may read robots in any scope.
 */
const docVersionReader: TargetResolver = Object.assign(
  async (req: FastifyRequest, db: import('@arnobot/db').Queryable) => {
    const id = assertUuid(String((req.params as Record<string, string>).id));
    const r = (await db.query<{ robot_id: string | null }>('SELECT d.robot_id FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = $1', [id])).rows[0];
    if (!r) throw notFound('document version');
    return r.robot_id ? ({ type: 'robot', id: r.robot_id } as const) : ({ type: 'any' } as const);
  },
  { describe: 'robot of the document, else any scope' },
);

/** Documents (spec §3 row 7, §4, §8): files in storage, metadata here, each upload = new version. */
export function documentRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, documents, files } = app;
  const tag = 'Documents';
  const docOwner = robotVia('SELECT robot_id FROM documents WHERE id = $1', 'document');

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/documents',
    summary: 'Effective documents of a robot: its own ∪ its hardware revision ∪ its product',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    query: z.object({ include_deleted: optionalBool }),
    handler: async ({ params, query }): Promise<DocumentDto[]> => {
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      return documents.effectiveForRobot(params.robotId, db, query.include_deleted ?? false);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/documents',
    summary: 'Create a document with its first version (multipart: file + fields)',
    tag,
    access: { can: 'document.write', target: robotFromBody() },
    upload: true,
    body: createFields,
    status: 201,
    handler: ({ body, file, user }) =>
      withTransaction(db, async (tx) => {
        let prefix: string;
        if (body.robot_id) {
          await app.robots.assertExists(body.robot_id, {}, tx);
          prefix = `robots/${body.robot_id}/docs`;
        } else if (body.hardware_revision_id) {
          const r = (await tx.query<{ code: string }>('SELECT p.code FROM hardware_revisions h JOIN products p ON p.id = h.product_id WHERE h.id = $1 AND h.deleted_at IS NULL', [body.hardware_revision_id])).rows[0];
          if (!r) throw notFound('hardware revision');
          prefix = `products/${r.code}/revisions/${body.hardware_revision_id}/docs`;
        } else {
          const r = (await tx.query<{ code: string }>('SELECT code FROM products WHERE id = $1 AND deleted_at IS NULL', [body.product_id])).rows[0];
          if (!r) throw notFound('product');
          prefix = `products/${r.code}/docs`;
        }
        const docId = (
          await tx.query<{ id: string }>(
            `INSERT INTO documents (doc_type, title, product_id, hardware_revision_id, robot_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [body.doc_type, body.title, body.product_id ?? null, body.hardware_revision_id ?? null, body.robot_id ?? null, user.id],
          )
        ).rows[0].id;
        const fileId = await files.store(file, `${prefix}/${docId}/v1`, user.id, tx);
        await tx.query('INSERT INTO document_versions (document_id, version_no, file_id, note, uploaded_by) VALUES ($1, 1, $2, $3, $4)', [
          docId,
          fileId,
          body.note ?? null,
          user.id,
        ]);
        return documents.getDto(docId, tx);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/documents/:id/versions',
    summary: 'Upload a new version; older versions stay available',
    tag,
    access: { can: 'document.write', target: docOwner },
    upload: true,
    body: versionFields,
    status: 201,
    handler: ({ params, body, file, user }) =>
      withTransaction(db, async (tx) => {
        const d = (await tx.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM documents WHERE id = $1 FOR UPDATE', [params.id])).rows[0];
        if (!d) throw notFound('document');
        if (d.deleted_at) throw conflict('document is deleted; restore it first');
        const next = (await tx.query<{ n: number }>('SELECT coalesce(max(version_no), 0) + 1 AS n FROM document_versions WHERE document_id = $1', [params.id])).rows[0].n;
        const fileId = await files.store(file, `documents/${params.id}/v${next}`, user.id, tx);
        await tx.query('INSERT INTO document_versions (document_id, version_no, file_id, note, uploaded_by) VALUES ($1, $2, $3, $4, $5)', [
          params.id,
          next,
          fileId,
          body.note ?? null,
          user.id,
        ]);
        await tx.query('UPDATE documents SET updated_at = now() WHERE id = $1', [params.id]);
        return documents.getDto(params.id, tx);
      }),
  });

  route(f, app, {
    method: 'PATCH',
    path: '/documents/:id',
    summary: 'Rename a document',
    tag,
    access: { can: 'document.write', target: docOwner },
    body: z.object({ title: z.string().trim().min(1).max(300) }),
    handler: async ({ params, body }) => {
      await db.query('UPDATE documents SET title = $2 WHERE id = $1', [params.id, body.title]);
      return documents.getDto(params.id);
    },
  });

  for (const [path, deleted] of [
    ['/documents/:id', true],
    ['/documents/:id/restore', false],
  ] as const) {
    route(f, app, {
      method: deleted ? 'DELETE' : 'POST',
      path,
      summary: deleted ? 'Soft-delete a document (versions and files are kept)' : 'Restore a document',
      tag,
      access: { can: 'document.write', target: docOwner },
      handler: async ({ params }) => {
        const res = await db.query(`UPDATE documents SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
        if (!res.rowCount) throw conflict(deleted ? 'already deleted' : 'not deleted');
        return documents.getDto(params.id);
      },
    });
  }

  route(f, app, {
    method: 'GET',
    path: '/document-versions/:id/download',
    summary: 'Download one document version',
    tag,
    access: { can: 'robot.read', target: docVersionReader },
    handler: async ({ params, reply }) => {
      const v = (await db.query<{ file_id: string }>('SELECT file_id FROM document_versions WHERE id = $1', [params.id])).rows[0];
      if (!v) throw badRequest('unknown version');
      return files.send(v.file_id, reply);
    },
  });
}
