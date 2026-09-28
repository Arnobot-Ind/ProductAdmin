import { withTransaction, type Queryable } from '../db';
import type { CompanyDto, DocumentDto, HardwareRevisionDto, PartTypeDto, ProductDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { anyScope, platform, route } from '../lib/route';
import { iso } from '../lib/sql';
import { assertUuid, includeDeleted, nullableText, optionalBool } from '../lib/validation';

const PRODUCT_SELECT = `
SELECT p.id, p.code, p.name, p.description, p.next_running_number, p.created_at, p.deleted_at,
       (SELECT count(*)::int FROM robots r WHERE r.product_id = p.id AND r.deleted_at IS NULL) AS robot_count,
       (SELECT count(*)::int FROM hardware_revisions h WHERE h.product_id = p.id AND h.deleted_at IS NULL) AS revision_count
FROM products p`;
const toProduct = (r: Record<string, unknown>): ProductDto => ({
  ...(r as unknown as ProductDto),
  created_at: iso(r.created_at as Date)!,
  deleted_at: iso(r.deleted_at as Date | null),
});

const componentsSchema = z
  .array(
    z.object({
      part_type_key: z.string().min(1).max(50),
      slot: z.coerce.number().int().min(1).max(64).nullable().optional(),
      model: nullableText(200).optional(),
    }),
  )
  .max(64);

/** Product catalogue (spec §4). Products, revisions and part types are DATA (rule 15). */
export function catalogueRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Catalogue';
  const read = { can: 'catalog.read', target: anyScope() };
  const write = { can: 'catalog.write', target: platform() };

  const productById = async (id: string, q: Queryable) => {
    assertUuid(id);
    const r = (await q.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [id])).rows[0];
    if (!r) throw notFound('product');
    return toProduct(r);
  };
  const revisions = async (where: string, params: unknown[], q: Queryable): Promise<HardwareRevisionDto[]> => {
    const rows = await q.query(
      `SELECT h.id, h.product_id, h.name, h.description, h.created_at, h.deleted_at,
              (SELECT count(*)::int FROM robots r WHERE r.hardware_revision_id = h.id AND r.deleted_at IS NULL) AS robot_count,
              coalesce((SELECT json_agg(json_build_object('id', c.id, 'part_type_key', pt.key, 'part_type_name', pt.name,
                                                          'slot', c.slot, 'model', c.model) ORDER BY pt.name, c.slot)
                        FROM hardware_revision_components c JOIN part_types pt ON pt.id = c.part_type_id
                        WHERE c.hardware_revision_id = h.id AND c.deleted_at IS NULL), '[]') AS components
       FROM hardware_revisions h ${where} ORDER BY h.name`,
      params,
    );
    return rows.rows.map((r) => ({ ...r, created_at: iso(r.created_at)!, deleted_at: iso(r.deleted_at) }));
  };
  const revisionById = async (id: string, q: Queryable) => {
    assertUuid(id);
    const r = await revisions('WHERE h.id = $1', [id], q);
    if (!r.length) throw notFound('hardware revision');
    return r[0];
  };
  const setComponents = async (tx: PoolClient, revisionId: string, comps: z.infer<typeof componentsSchema>, userId: string) => {
    await tx.query('UPDATE hardware_revision_components SET deleted_at = now() WHERE hardware_revision_id = $1 AND deleted_at IS NULL', [revisionId]);
    for (const c of comps) {
      const pt = (await tx.query<{ id: string }>('SELECT id FROM part_types WHERE key = $1 AND deleted_at IS NULL', [c.part_type_key])).rows[0];
      if (!pt) throw badRequest(`unknown part type ${c.part_type_key}`);
      await tx.query('INSERT INTO hardware_revision_components (hardware_revision_id, part_type_id, slot, model, created_by) VALUES ($1, $2, $3, $4, $5)', [
        revisionId,
        pt.id,
        c.slot ?? null,
        c.model ?? null,
        userId,
      ]);
    }
  };

  route(f, app, {
    method: 'GET',
    path: '/companies',
    summary: 'Companies (v1: Arnobot only)',
    tag,
    access: read,
    handler: async (): Promise<CompanyDto[]> =>
      (await db.query('SELECT id, name, created_at FROM companies WHERE deleted_at IS NULL ORDER BY name')).rows.map((r) => ({ ...r, created_at: iso(r.created_at)! })),
  });

  route(f, app, {
    method: 'GET',
    path: '/part-types',
    summary: 'Part types (GPS, encoder, IMU, LiDAR, camera, controller …)',
    tag,
    access: read,
    handler: async (): Promise<PartTypeDto[]> => (await db.query('SELECT id, key, name, max_per_robot FROM part_types WHERE deleted_at IS NULL ORDER BY name')).rows,
  });
  route(f, app, {
    method: 'POST',
    path: '/part-types',
    summary: 'Add a part type (data, not code)',
    tag,
    access: write,
    status: 201,
    body: z.object({
      key: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits, underscore').max(50),
      name: z.string().trim().min(1).max(100),
      max_per_robot: z.coerce.number().int().min(1).max(64).nullable().optional(),
    }),
    handler: async ({ body }): Promise<PartTypeDto> =>
      (await db.query('INSERT INTO part_types (key, name, max_per_robot) VALUES ($1, $2, $3) RETURNING id, key, name, max_per_robot', [body.key, body.name, body.max_per_robot ?? null])).rows[0],
  });

  route(f, app, {
    method: 'GET',
    path: '/products',
    summary: 'Products',
    tag,
    access: read,
    query: z.object(includeDeleted),
    handler: async ({ query }): Promise<ProductDto[]> =>
      (await db.query(`${PRODUCT_SELECT} ${query.include_deleted ? '' : 'WHERE p.deleted_at IS NULL'} ORDER BY p.name`)).rows.map(toProduct),
  });
  route(f, app, {
    method: 'POST',
    path: '/products',
    summary: 'Add a product (its code prefixes Robot IDs and is permanent)',
    tag,
    access: write,
    status: 201,
    body: z.object({
      code: z.string().trim().regex(/^[a-z][a-z_]*$/, 'lowercase letters and underscore only (it prefixes robot IDs)').max(30),
      name: z.string().trim().min(1).max(100),
      description: nullableText(2000).optional(),
    }),
    handler: async ({ body, user }) => {
      const exists = await db.query('SELECT 1 FROM products WHERE code = $1', [body.code]);
      if (exists.rowCount) throw conflict(`product code ${body.code} is already used (codes are never reused)`);
      const id = (await db.query<{ id: string }>('INSERT INTO products (code, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [body.code, body.name, body.description ?? null, user.id])).rows[0].id;
      return productById(id, db);
    },
  });
  route(f, app, {
    method: 'GET',
    path: '/products/:id',
    summary: 'Product with its hardware revisions and main components',
    tag,
    access: read,
    query: z.object({ include_deleted: optionalBool }),
    handler: async ({ params, query }) => ({
      ...(await productById(params.id, db)),
      revisions: await revisions(`WHERE h.product_id = $1 ${query.include_deleted ? '' : 'AND h.deleted_at IS NULL'}`, [params.id], db),
    }),
  });
  route(f, app, {
    method: 'PATCH',
    path: '/products/:id',
    summary: 'Rename / describe a product (code is permanent)',
    tag,
    access: write,
    body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: nullableText(2000).optional() }).strict(),
    handler: async ({ params, body }) => {
      await productById(params.id, db);
      if (body.name !== undefined) await db.query('UPDATE products SET name = $2 WHERE id = $1', [params.id, body.name]);
      if (body.description !== undefined) await db.query('UPDATE products SET description = $2 WHERE id = $1', [params.id, body.description]);
      return productById(params.id, db);
    },
  });
  route(f, app, {
    method: 'GET',
    path: '/products/:id/documents',
    summary: 'Documents on the product and its revisions',
    tag,
    access: read,
    query: z.object(includeDeleted),
    handler: async ({ params, query }): Promise<DocumentDto[]> => {
      await productById(params.id, db);
      return app.documents.forProduct(params.id, db, query.include_deleted ?? false);
    },
  });
  route(f, app, {
    method: 'POST',
    path: '/products/:id/revisions',
    summary: 'Create a hardware revision with its main components',
    tag,
    access: write,
    status: 201,
    body: z.object({ name: z.string().trim().min(1).max(100), description: nullableText(2000).optional(), components: componentsSchema.optional() }),
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        const p = await productById(params.id, tx);
        if (p.deleted_at) throw conflict('product is deleted');
        const id = (
          await tx.query<{ id: string }>('INSERT INTO hardware_revisions (product_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
            params.id,
            body.name,
            body.description ?? null,
            user.id,
          ])
        ).rows[0].id;
        await setComponents(tx, id, body.components ?? [], user.id);
        return revisionById(id, tx);
      }),
  });
  route(f, app, {
    method: 'PATCH',
    path: '/revisions/:id',
    summary: 'Rename / describe a hardware revision',
    tag,
    access: write,
    body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: nullableText(2000).optional() }).strict(),
    handler: async ({ params, body }) => {
      await revisionById(params.id, db);
      if (body.name !== undefined) await db.query('UPDATE hardware_revisions SET name = $2 WHERE id = $1', [params.id, body.name]);
      if (body.description !== undefined) await db.query('UPDATE hardware_revisions SET description = $2 WHERE id = $1', [params.id, body.description]);
      return revisionById(params.id, db);
    },
  });
  route(f, app, {
    method: 'PUT',
    path: '/revisions/:id/components',
    summary: 'Replace the main components of a revision (old rows kept, soft-deleted)',
    tag,
    access: write,
    body: z.object({ components: componentsSchema }),
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        await revisionById(params.id, tx);
        await setComponents(tx, params.id, body.components, user.id);
        return revisionById(params.id, tx);
      }),
  });

  for (const [table, what, base] of [
    ['products', 'product', '/products/:id'],
    ['hardware_revisions', 'hardware revision', '/revisions/:id'],
  ] as const) {
    for (const deleted of [true, false]) {
      route(f, app, {
        method: deleted ? 'DELETE' : 'POST',
        path: deleted ? base : `${base}/restore`,
        summary: `${deleted ? 'Soft-delete' : 'Restore'} a ${what}`,
        tag,
        access: write,
        handler: async ({ params }) => {
          assertUuid(params.id);
          if (deleted && table === 'products') {
            const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM robots WHERE product_id = $1 AND deleted_at IS NULL', [params.id])).rows[0].n;
            if (n) throw conflict(`product still has ${n} active robot(s)`);
          }
          const res = await db.query(`UPDATE ${table} SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
          if (!res.rowCount) throw conflict(`${what} not found or already ${deleted ? 'deleted' : 'active'}`);
          return table === 'products' ? productById(params.id, db) : revisionById(params.id, db);
        },
      });
    }
  }
}
