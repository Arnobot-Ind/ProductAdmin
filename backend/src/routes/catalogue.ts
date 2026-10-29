import { withTransaction, type Queryable } from '../db';
import { PRODUCT_MEDIA_KINDS, ROBOT_CATEGORIES, type DocumentDto, type HardwareRevisionDto, type PartTypeDto, type ProductDto, type ProductMediaDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { anyScope, platform, route } from '../lib/route';
import { iso } from '../lib/sql';
import { assertUuid, includeDeleted, nullableText, optionalBool, repoUrlField } from '../lib/validation';

const PRODUCT_SELECT = `
SELECT p.id, p.code, p.name, p.description, p.category, p.repo_url, p.next_running_number, p.created_at, p.deleted_at,
       (SELECT pm.id FROM product_media pm WHERE pm.product_id = p.id AND pm.kind = 'photo' AND pm.deleted_at IS NULL ORDER BY pm.created_at LIMIT 1) AS cover_photo_id,
       (SELECT pm.id FROM product_media pm WHERE pm.product_id = p.id AND pm.kind = 'model_3d' AND pm.deleted_at IS NULL ORDER BY pm.created_at DESC LIMIT 1) AS model_3d_id,
       (SELECT count(*)::int FROM product_media pm WHERE pm.product_id = p.id AND pm.kind = 'photo' AND pm.deleted_at IS NULL) AS photo_count,
       (SELECT count(*)::int FROM product_media pm WHERE pm.product_id = p.id AND pm.kind = 'spin' AND pm.deleted_at IS NULL) AS spin_count,
       (SELECT count(*)::int FROM robots r WHERE r.product_id = p.id AND r.deleted_at IS NULL) AS robot_count,
       (SELECT count(*)::int FROM hardware_revisions h WHERE h.product_id = p.id AND h.deleted_at IS NULL) AS revision_count
FROM products p`;
const toProduct = (r: Record<string, unknown>): ProductDto => ({
  ...(r as unknown as ProductDto),
  created_at: iso(r.created_at as Date)!,
  deleted_at: iso(r.deleted_at as Date | null),
});

const MEDIA_SELECT = `
SELECT pm.id, pm.product_id, pm.attachment_id, pm.kind, pm.position, pm.caption, f.filename, f.content_type, f.size_bytes, pm.created_at, u.name AS created_by_name
FROM product_media pm JOIN files f ON f.id = pm.file_id LEFT JOIN users u ON u.id = pm.created_by`;
const toMedia = (r: Record<string, unknown>): ProductMediaDto => ({ ...(r as unknown as ProductMediaDto), created_at: iso(r.created_at as Date)! });
/** Photos: raster images only (an SVG could carry script). 3D: binary glTF, which the browser viewer reads. */
const PHOTO_TYPES = /^image\/(png|jpe?g|webp|gif|avif)$/i;
/** Enough for a smooth turn (36 = one photo every 10°, 72 = every 5°). */
const MAX_SPIN = 120;
const isGlb = (filename: string) => /\.glb$/i.test(filename);

const componentsSchema = z
  .array(
    z.object({
      part_type_key: z.string().min(1).max(50),
      slot: z.coerce.number().int().min(1).max(64).nullable().optional(),
      model: nullableText(200).optional(),
    }),
  )
  .max(64);

/**
 * Hardware revisions (of a base model or of an attachment) with their main components. Robot count: robots built
 * on a base model revision, or robots that have that attachment revision fitted now.
 */
export async function hardwareRevisions(where: string, params: unknown[], q: Queryable): Promise<HardwareRevisionDto[]> {
  const rows = await q.query(
    `SELECT h.id, h.product_id, h.attachment_id, h.name, h.description, h.created_at, h.deleted_at,
            CASE WHEN h.product_id IS NOT NULL THEN (SELECT count(*)::int FROM robots r WHERE r.hardware_revision_id = h.id AND r.deleted_at IS NULL)
                 ELSE (SELECT count(*)::int FROM robot_attachments ra JOIN robots r ON r.robot_id = ra.robot_id
                       WHERE ra.hardware_revision_id = h.id AND ra.removed_at IS NULL AND r.deleted_at IS NULL) END AS robot_count,
            coalesce((SELECT json_agg(json_build_object('id', c.id, 'part_type_key', pt.key, 'part_type_name', pt.name,
                                                        'slot', c.slot, 'model', c.model) ORDER BY pt.name, c.slot)
                      FROM hardware_revision_components c JOIN part_types pt ON pt.id = c.part_type_id
                      WHERE c.hardware_revision_id = h.id AND c.deleted_at IS NULL), '[]') AS components
     FROM hardware_revisions h ${where} ORDER BY h.name`,
    params,
  );
  return rows.rows.map((r) => ({ ...r, created_at: iso(r.created_at)!, deleted_at: iso(r.deleted_at) }));
}

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
  const revisions = hardwareRevisions;
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
      category: z.enum(ROBOT_CATEGORIES),
      repo_url: repoUrlField.optional(),
    }),
    handler: async ({ body, user }) => {
      const exists = await db.query('SELECT 1 FROM products WHERE code = $1', [body.code]);
      if (exists.rowCount) throw conflict(`product code ${body.code} is already used (codes are never reused)`);
      const id = (
        await db.query<{ id: string }>('INSERT INTO products (code, name, description, category, repo_url, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
          body.code,
          body.name,
          body.description ?? null,
          body.category,
          body.repo_url ?? null,
          user.id,
        ])
      ).rows[0].id;
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
    summary: 'Rename / describe a product, set its category (UGV / UAV) or software repository (code is permanent)',
    tag,
    access: write,
    body: z
      .object({ name: z.string().trim().min(1).max(100).optional(), description: nullableText(2000).optional(), category: z.enum(ROBOT_CATEGORIES).optional(), repo_url: repoUrlField.optional() })
      .strict(),
    handler: async ({ params, body }) => {
      await productById(params.id, db);
      for (const key of ['name', 'description', 'category', 'repo_url'] as const) {
        if (body[key] !== undefined) await db.query(`UPDATE products SET ${key} = $2 WHERE id = $1`, [params.id, body[key]]);
      }
      return productById(params.id, db);
    },
  });

  // ── photos and 3D model ──────────────────────────────────────────────────
  // Staff only, like the rest of the catalogue (the robot page shows them to Arnobot staff).
  // A base model and an attachment keep the same kinds of pictures; `folder` checks the owner and names its storage folder.
  const mediaRead = read;
  const mediaOwners = [
    {
      base: '/products/:id',
      column: 'product_id',
      what: 'product',
      folder: async (id: string, tx: Queryable) => {
        const p = await productById(id, tx);
        if (p.deleted_at) throw conflict('product is deleted');
        return `products/${p.code}/media`;
      },
    },
    {
      base: '/attachments/:id',
      column: 'attachment_id',
      what: 'attachment',
      folder: async (id: string, tx: Queryable) => {
        assertUuid(id);
        const a = (await tx.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM attachments WHERE id = $1', [id])).rows[0];
        if (!a) throw notFound('attachment');
        if (a.deleted_at) throw conflict('attachment is retired');
        return `attachments/${id}/media`;
      },
    },
  ] as const;
  for (const o of mediaOwners) {
    route(f, app, {
      method: 'GET',
      path: `${o.base}/media`,
      summary: `Photos, 3D model and 360° series of a ${o.what} (photos oldest first, the series in order)`,
      tag,
      access: mediaRead,
      handler: async ({ params }): Promise<ProductMediaDto[]> => {
        assertUuid(params.id);
        return (await db.query(`${MEDIA_SELECT} WHERE pm.${o.column} = $1 AND pm.deleted_at IS NULL ORDER BY pm.kind, pm.position, pm.created_at`, [params.id])).rows.map(toMedia);
      },
    });
    route(f, app, {
      method: 'POST',
      path: `${o.base}/media`,
      summary: `Upload a photo or a 360° series photo (PNG, JPEG, WebP, GIF, AVIF), or the 3D model (.glb) of a ${o.what} (multipart: file, kind, caption). Series photos are added at the end, in upload order.`,
      tag,
      access: write,
      upload: true,
      body: z.object({ kind: z.enum(PRODUCT_MEDIA_KINDS), caption: nullableText(300).optional() }),
      status: 201,
      handler: ({ params, body, file, user }) =>
        withTransaction(db, async (tx) => {
          const folder = await o.folder(params.id, tx);
          if (file && body.kind !== 'model_3d' && !PHOTO_TYPES.test(file.mimetype)) throw badRequest('a photo must be a PNG, JPEG, WebP, GIF or AVIF image');
          if (body.kind === 'spin' && (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM product_media WHERE ${o.column} = $1 AND kind = 'spin' AND deleted_at IS NULL`, [params.id])).rows[0].n >= MAX_SPIN)
            throw badRequest(`a 360° series has at most ${MAX_SPIN} photos`);
          if (file && body.kind === 'model_3d' && !isGlb(file.filename)) throw badRequest('the 3D model must be a binary glTF file (.glb)');
          if (body.kind === 'model_3d') await tx.query(`UPDATE product_media SET deleted_at = now() WHERE ${o.column} = $1 AND kind = 'model_3d' AND deleted_at IS NULL`, [params.id]);
          if (file && body.kind === 'model_3d') file.mimetype = 'model/gltf-binary';
          const fileId = await app.files.store(file, folder, user.id, tx);
          const id = (
            await tx.query<{ id: string }>(
              `INSERT INTO product_media (${o.column}, kind, file_id, position, caption, created_by)
               VALUES ($1, $2, $3, (SELECT coalesce(max(position), 0) + 1 FROM product_media WHERE ${o.column} = $1 AND kind = $2 AND deleted_at IS NULL), $4, $5) RETURNING id`,
              [params.id, body.kind, fileId, body.caption ?? null, user.id],
            )
          ).rows[0].id;
          return toMedia((await tx.query(`${MEDIA_SELECT} WHERE pm.id = $1`, [id])).rows[0]);
        }),
    });
    route(f, app, {
      method: 'DELETE',
      path: `${o.base}/spin`,
      summary: 'Remove the whole 360° series (to replace it with new photos; files are kept)',
      tag,
      access: write,
      handler: async ({ params }) => {
        assertUuid(params.id);
        const res = await db.query(`UPDATE product_media SET deleted_at = now() WHERE ${o.column} = $1 AND kind = 'spin' AND deleted_at IS NULL`, [params.id]);
        return { removed: res.rowCount ?? 0 };
      },
    });
  }
  route(f, app, {
    method: 'DELETE',
    path: '/product-media/:id',
    summary: 'Remove a photo or the 3D model (the file is kept)',
    tag,
    access: write,
    handler: async ({ params }) => {
      assertUuid(params.id);
      const res = await db.query('UPDATE product_media SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [params.id]);
      if (!res.rowCount) throw notFound('photo or model');
      return { ok: true };
    },
  });
  route(f, app, {
    method: 'GET',
    path: '/product-media/:id/file',
    summary: 'The photo (shown inline) or 3D model file',
    tag,
    access: mediaRead,
    handler: async ({ params, reply }) => {
      assertUuid(params.id);
      const m = (await db.query<{ file_id: string; kind: string }>('SELECT file_id, kind FROM product_media WHERE id = $1 AND deleted_at IS NULL', [params.id])).rows[0];
      if (!m) throw notFound('photo or model');
      return app.files.send(m.file_id, reply, { inline: m.kind !== 'model_3d' });
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
    method: 'GET',
    path: '/attachments/:id/documents',
    summary: 'Documents on the attachment and its revisions',
    tag,
    access: read,
    query: z.object(includeDeleted),
    handler: async ({ params, query }): Promise<DocumentDto[]> => {
      assertUuid(params.id);
      if (!(await db.query('SELECT 1 FROM attachments WHERE id = $1', [params.id])).rowCount) throw notFound('attachment');
      return app.documents.forAttachment(params.id, db, query.include_deleted ?? false);
    },
  });
  for (const o of mediaOwners) {
    route(f, app, {
      method: 'POST',
      path: `${o.base}/revisions`,
      summary: `Create a hardware revision of a ${o.what} with its main components`,
      tag,
      access: write,
      status: 201,
      body: z.object({ name: z.string().trim().min(1).max(100), description: nullableText(2000).optional(), components: componentsSchema.optional() }),
      handler: ({ params, body, user }) =>
        withTransaction(db, async (tx) => {
          await o.folder(params.id, tx);
          if ((await tx.query(`SELECT 1 FROM hardware_revisions WHERE ${o.column} = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`, [params.id, body.name])).rowCount)
            throw conflict(`a revision named ${body.name} already exists`);
          const id = (
            await tx.query<{ id: string }>(`INSERT INTO hardware_revisions (${o.column}, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [
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
  }
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
