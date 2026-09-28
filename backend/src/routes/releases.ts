import { withTransaction, type Queryable } from '../db';
import { RELEASE_COMPONENTS, type ReleaseDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { anyScope, platform, route } from '../lib/route';
import { iso } from '../lib/sql';
import { assertUuid, optionalBool, optionalText, uuidSchema } from '../lib/validation';
import { FILE_COLUMNS, toFileDto, type FileRow } from '../services/files.service';

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/;
const SELECT = `
SELECT r.id, r.product_id, p.code AS product_code, r.component, r.version, r.sha256, r.signature, r.signature_algo,
       r.requires_component, r.requires_min_version, r.notes, r.created_at, u.name AS created_by_name, r.deleted_at,
       (SELECT row_to_json(x) FROM (SELECT ${FILE_COLUMNS} FROM files f WHERE f.id = r.file_id) x) AS file
FROM releases r JOIN products p ON p.id = r.product_id LEFT JOIN users u ON u.id = r.created_by`;
const toRelease = (r: Record<string, unknown>): ReleaseDto => ({
  ...(r as unknown as ReleaseDto),
  file: r.file ? toFileDto({ ...(r.file as FileRow), uploaded_at: new Date((r.file as FileRow).uploaded_at) }) : null,
  created_at: iso(r.created_at as Date)!,
  deleted_at: iso(r.deleted_at as Date | null),
});

const createFields = z
  .object({
    product_id: uuidSchema,
    component: z.enum(RELEASE_COMPONENTS),
    version: z.string().trim().regex(SEMVER, 'version must be semver, e.g. 1.4.0'),
    signature: z.string().trim().min(1).max(8192),
    signature_algo: optionalText(50),
    sha256: optionalText(64).refine((v) => v === undefined || /^[a-f0-9]{64}$/i.test(v), 'sha256 must be 64 hex chars'),
    requires_component: z.enum(RELEASE_COMPONENTS).optional().or(z.literal('').transform(() => undefined)),
    requires_min_version: optionalText(50).refine((v) => v === undefined || SEMVER.test(v), 'requires_min_version must be semver'),
    notes: optionalText(4000),
  })
  .refine((v) => !v.requires_component === !v.requires_min_version, { message: 'requires_component and requires_min_version go together' })
  .refine((v) => !v.requires_component || v.requires_component !== v.component, { message: 'requirement must be on the OTHER component' });

/**
 * Software & firmware releases (spec §9): one record per version, all kept. The SHA-256 is computed
 * from the uploaded package by the server (a declared value must match). The Arnobot signature is
 * recorded; robots verify both and refuse a package that fails either check.
 */
export function releaseRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Releases';
  const byId = async (id: string, q: Queryable) => {
    const r = (await q.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0];
    if (!r) throw notFound('release');
    return toRelease(r);
  };

  route(f, app, {
    method: 'GET',
    path: '/releases',
    summary: 'Release registry',
    tag,
    access: { can: 'catalog.read', target: anyScope() },
    query: z.object({ product_id: uuidSchema.optional(), component: z.enum(RELEASE_COMPONENTS).optional(), include_deleted: optionalBool }),
    handler: async ({ query }): Promise<ReleaseDto[]> => {
      const cond: string[] = [];
      const params: unknown[] = [];
      if (query.product_id) cond.push(`r.product_id = $${params.push(query.product_id)}`);
      if (query.component) cond.push(`r.component = $${params.push(query.component)}`);
      if (!query.include_deleted) cond.push('r.deleted_at IS NULL');
      const rows = await db.query(
        `${SELECT} ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
         ORDER BY p.code, r.component, string_to_array(regexp_replace(r.version, '[-+].*$', ''), '.')::int[] DESC`,
        params,
      );
      return rows.rows.map(toRelease);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/releases',
    summary: 'Register a release (multipart: optional package file + fields)',
    tag,
    access: { can: 'release.write', target: platform() },
    upload: true,
    body: createFields,
    status: 201,
    handler: ({ body, file, user }) =>
      withTransaction(db, async (tx) => {
        const product = (await tx.query<{ code: string }>('SELECT code FROM products WHERE id = $1 AND deleted_at IS NULL', [body.product_id])).rows[0];
        if (!product) throw notFound('product');
        const dup = await tx.query('SELECT 1 FROM releases WHERE product_id = $1 AND component = $2 AND version = $3', [body.product_id, body.component, body.version]);
        if (dup.rowCount) throw conflict(`${product.code} ${body.component} ${body.version} already exists (version numbers are never reused)`);
        let fileId: string | null = null;
        let sha256 = body.sha256?.toLowerCase() ?? null;
        if (file) {
          fileId = await app.files.store(file, `releases/${product.code}/${body.component}/${body.version}`, user.id, tx, sha256);
          sha256 = (await tx.query<{ sha256: string }>('SELECT sha256 FROM files WHERE id = $1', [fileId])).rows[0].sha256;
        }
        if (!sha256) throw badRequest('upload the package file, or give its sha256');
        const id = (
          await tx.query<{ id: string }>(
            `INSERT INTO releases (product_id, component, version, file_id, sha256, signature, signature_algo, requires_component, requires_min_version, notes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [
              body.product_id,
              body.component,
              body.version,
              fileId,
              sha256,
              body.signature,
              body.signature_algo ?? null,
              body.requires_component ?? null,
              body.requires_min_version ?? null,
              body.notes ?? null,
              user.id,
            ],
          )
        ).rows[0].id;
        return byId(id, tx);
      }),
  });

  route(f, app, {
    method: 'GET',
    path: '/releases/:id/download',
    summary: 'Download a release package',
    tag,
    access: { can: 'catalog.read', target: anyScope() },
    handler: async ({ params, reply }) => {
      const r = await byId(params.id, db);
      if (!r.file) throw notFound('package file');
      return app.files.send(r.file.id, reply);
    },
  });

  for (const [path, deleted] of [
    ['/releases/:id', true],
    ['/releases/:id/restore', false],
  ] as const) {
    route(f, app, {
      method: deleted ? 'DELETE' : 'POST',
      path,
      summary: deleted ? 'Withdraw a release (soft delete; version stays reserved)' : 'Restore a release',
      tag,
      access: { can: 'release.write', target: platform() },
      handler: async ({ params }) => {
        assertUuid(params.id);
        const res = await db.query(`UPDATE releases SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
        if (!res.rowCount) throw conflict(deleted ? 'already withdrawn' : 'not withdrawn');
        return byId(params.id, db);
      },
    });
  }
}
