import { withTransaction, type Queryable } from '../db';
import type { HardwarePartDto, MaintenanceDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { robotParam, robotVia, route } from '../lib/route';
import { iso } from '../lib/sql';
import { includeDeleted, isoDate, nullableText, optionalBool, uuidSchema } from '../lib/validation';

const PART_SELECT = `
SELECT h.id, pt.key AS part_type_key, pt.name AS part_type_name, h.slot, h.model, h.serial_number, h.fitted_at, h.removed_at,
       h.removal_reason, coalesce(h.removed_maintenance_id, h.fitted_maintenance_id) AS maintenance_log_id, h.notes, h.product_url,
       h.created_at, h.updated_at, uu.name AS updated_by_name
FROM hardware_fitted h JOIN part_types pt ON pt.id = h.part_type_id LEFT JOIN users uu ON uu.id = h.updated_by`;
const toPart = (r: Record<string, unknown>): HardwarePartDto => ({
  ...(r as unknown as HardwarePartDto),
  created_at: iso(r.created_at as Date)!,
  updated_at: iso(r.updated_at as Date | null),
});

/** http(s) link to the part's product page or datasheet; empty → null. */
const productUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v),
  z.string().max(1000).regex(/^https?:\/\/[^\s/@]+(\/\S*)?$/i, 'must be an http(s) link without user:password').nullable(),
);

const MAINT_SELECT = `
SELECT m.id, m.robot_id, m.repaired_at, m.description, m.part_removed_serial, m.part_fitted_serial, m.repaired_by,
       (SELECT id FROM hardware_fitted WHERE removed_maintenance_id = m.id LIMIT 1) AS hardware_removed_id,
       (SELECT id FROM hardware_fitted WHERE fitted_maintenance_id = m.id LIMIT 1) AS hardware_fitted_id,
       m.created_at, u.name AS created_by_name, m.deleted_at
FROM maintenance_log m LEFT JOIN users u ON u.id = m.created_by`;
const toMaint = (r: Record<string, unknown>): MaintenanceDto => ({
  ...(r as unknown as MaintenanceDto),
  created_at: iso(r.created_at as Date)!,
  deleted_at: iso(r.deleted_at as Date | null),
});

const fitBody = z.object({
  part_type_key: z.string().min(1).max(50),
  slot: z.coerce.number().int().min(1).max(64).nullable().optional(),
  model: nullableText(200).optional(),
  serial_number: nullableText(200).optional(),
  product_url: productUrl.optional(),
  fitted_at: isoDate,
  notes: nullableText(2000).optional(),
});
/** Corrections of a fitted part. Part type and slot are permanent: a different part is a remove + fit. */
const patchPartBody = z
  .object({
    model: nullableText(200).optional(),
    serial_number: nullableText(200).optional(),
    product_url: productUrl.optional(),
    fitted_at: isoDate.optional(),
    notes: nullableText(2000).optional(),
  })
  .strict();
const removeBody = z.object({ removed_at: isoDate, reason: nullableText(500).optional() });
const maintBody = z.object({
  repaired_at: isoDate,
  description: z.string().trim().min(1).max(4000),
  repaired_by: z.string().trim().min(1).max(200),
  part_removed_serial: nullableText(200).optional(),
  part_fitted_serial: nullableText(200).optional(),
  swap: z
    .object({
      remove_hardware_id: uuidSchema.nullable().optional(),
      part_type_key: z.string().min(1).max(50),
      slot: z.coerce.number().int().min(1).max(64).nullable().optional(),
      model: nullableText(200).optional(),
    })
    .optional(),
});
const maintPatch = z
  .object({
    repaired_at: isoDate.optional(),
    description: z.string().trim().min(1).max(4000).optional(),
    repaired_by: z.string().trim().min(1).max(200).optional(),
    part_removed_serial: nullableText(200).optional(),
    part_fitted_serial: nullableText(200).optional(),
  })
  .strict();

/** Fits a part, enforcing the part type's max_per_robot and slot range. One current part per slot is a DB constraint. */
async function fitPart(
  tx: PoolClient,
  robotId: string,
  input: { part_type_key: string; slot?: number | null; model?: string | null; serial_number?: string | null; product_url?: string | null; fitted_at: string; notes?: string | null },
  userId: string,
  maintenanceId: string | null,
): Promise<string> {
  const pt = (await tx.query<{ id: string; max_per_robot: number | null; name: string }>('SELECT id, max_per_robot, name FROM part_types WHERE key = $1 AND deleted_at IS NULL', [input.part_type_key])).rows[0];
  if (!pt) throw badRequest(`unknown part type ${input.part_type_key}`);
  if (pt.max_per_robot !== null) {
    if (input.slot && input.slot > pt.max_per_robot) throw badRequest(`${pt.name} slot must be 1–${pt.max_per_robot}`);
    const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM hardware_fitted WHERE robot_id = $1 AND part_type_id = $2 AND removed_at IS NULL', [robotId, pt.id])).rows[0].n;
    if (n >= pt.max_per_robot) throw conflict(`robot already has ${n} current ${pt.name} part(s) (max ${pt.max_per_robot}); remove one first`);
  }
  const res = await tx.query<{ id: string }>(
    `INSERT INTO hardware_fitted (robot_id, part_type_id, slot, model, serial_number, product_url, fitted_at, notes, fitted_maintenance_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [robotId, pt.id, input.slot ?? null, input.model ?? null, input.serial_number ?? null, input.product_url ?? null, input.fitted_at, input.notes ?? null, maintenanceId, userId],
  );
  return res.rows[0].id;
}

export function hardwareRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, robots } = app;

  // ── hardware fitted (spec §3 row 3) ──────────────────────────────────────
  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/hardware',
    summary: 'Hardware fitted: current parts (?current=true) or full history',
    tag: 'Hardware',
    access: { can: 'robot.read', target: robotParam() },
    query: z.object({ current: optionalBool }),
    handler: async ({ params, query }): Promise<HardwarePartDto[]> => {
      await robots.assertExists(params.robotId, { allowDeleted: true });
      const rows = await db.query(
        `${PART_SELECT} WHERE h.robot_id = $1 ${query.current ? 'AND h.removed_at IS NULL' : ''}
         ORDER BY (h.removed_at IS NOT NULL), pt.name, h.slot NULLS FIRST, h.fitted_at DESC`,
        [params.robotId],
      );
      return rows.rows.map(toPart);
    },
  });
  route(f, app, {
    method: 'POST',
    path: '/robots/:robotId/hardware',
    summary: 'Fit a part (history kept: one row per fitting)',
    tag: 'Hardware',
    access: { can: 'hardware.write', target: robotParam() },
    body: fitBody,
    status: 201,
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        await robots.assertExists(params.robotId, {}, tx);
        const id = await fitPart(tx, params.robotId, body, user.id, null);
        return toPart((await tx.query(`${PART_SELECT} WHERE h.id = $1`, [id])).rows[0]);
      }),
  });
  route(f, app, {
    method: 'PATCH',
    path: '/hardware/:id',
    summary: 'Correct a fitted part: model, serial number, product URL, fitted date, notes (audited)',
    tag: 'Hardware',
    access: { can: 'hardware.write', target: robotVia('SELECT robot_id FROM hardware_fitted WHERE id = $1', 'hardware part') },
    body: patchPartBody,
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const before = (await tx.query(`${PART_SELECT} WHERE h.id = $1 FOR UPDATE OF h`, [params.id])).rows[0];
        if (!before) throw notFound('hardware part');
        if (body.fitted_at && before.removed_at && body.fitted_at > before.removed_at) throw badRequest('fitted date must be on or before the removal date');
        const sets: string[] = [];
        const values: unknown[] = [params.id];
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const key of ['model', 'serial_number', 'product_url', 'fitted_at', 'notes'] as const) {
          if (body[key] === undefined || body[key] === before[key]) continue;
          values.push(body[key]);
          sets.push(`${key} = $${values.length}`);
          changes[key] = { from: before[key], to: body[key] };
        }
        if (sets.length) {
          values.push(user.id);
          await tx.query(`UPDATE hardware_fitted SET ${sets.join(', ')}, updated_at = now(), updated_by = $${values.length} WHERE id = $1`, values);
          const robotId = (await tx.query<{ robot_id: string }>('SELECT robot_id FROM hardware_fitted WHERE id = $1', [params.id])).rows[0].robot_id;
          await app.audit.record(
            { action: 'hardware.updated', actor: user, target: { type: 'hardware_part', id: params.id }, robotId, detail: { part: before.part_type_name, slot: before.slot, changes }, req },
            tx,
          );
        }
        return toPart((await tx.query(`${PART_SELECT} WHERE h.id = $1`, [params.id])).rows[0]);
      }),
  });
  route(f, app, {
    method: 'POST',
    path: '/hardware/:id/remove',
    summary: 'Mark a fitted part as removed (the row is kept)',
    tag: 'Hardware',
    access: { can: 'hardware.write', target: robotVia('SELECT robot_id FROM hardware_fitted WHERE id = $1', 'hardware part') },
    body: removeBody,
    handler: async ({ params, body }) => {
      const res = await db.query(
        `UPDATE hardware_fitted SET removed_at = $2, removal_reason = $3 WHERE id = $1 AND removed_at IS NULL AND fitted_at <= $2`,
        [params.id, body.removed_at, body.reason ?? null],
      );
      if (!res.rowCount) throw conflict('part is already removed, or removal date is before the fitted date');
      return toPart((await db.query(`${PART_SELECT} WHERE h.id = $1`, [params.id])).rows[0]);
    },
  });

  // ── maintenance (row 9) ──────────────────────────────────────────────────
  const maintById = async (id: string, q: Queryable) => {
    const row = (await q.query(`${MAINT_SELECT} WHERE m.id = $1`, [id])).rows[0];
    if (!row) throw notFound('maintenance entry');
    return toMaint(row);
  };
  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/maintenance',
    summary: 'Repair log (one entry per repair)',
    tag: 'Maintenance',
    access: { can: 'robot.read', target: robotParam() },
    query: z.object(includeDeleted),
    handler: async ({ params, query }): Promise<MaintenanceDto[]> => {
      await robots.assertExists(params.robotId, { allowDeleted: true });
      const rows = await db.query(
        `${MAINT_SELECT} WHERE m.robot_id = $1 ${query.include_deleted ? '' : 'AND m.deleted_at IS NULL'} ORDER BY m.repaired_at DESC, m.created_at DESC`,
        [params.robotId],
      );
      return rows.rows.map(toMaint);
    },
  });
  route(f, app, {
    method: 'POST',
    path: '/robots/:robotId/maintenance',
    summary: 'Record a repair; with `swap`, closes the old part and fits the new one in the same transaction',
    tag: 'Maintenance',
    access: { can: 'maintenance.write', target: robotParam() },
    body: maintBody,
    status: 201,
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        const robotId = params.robotId;
        await robots.assertExists(robotId, {}, tx);
        let removedSerial = body.part_removed_serial ?? null;
        let slot = body.swap?.slot ?? null;
        let removedModel: string | null = null;
        let removed: { id: string; serial_number: string | null; slot: number | null; model: string | null; fitted_at: string } | undefined;
        if (body.swap?.remove_hardware_id) {
          removed = (
            await tx.query('SELECT id, serial_number, slot, model, fitted_at FROM hardware_fitted WHERE id = $1 AND robot_id = $2 AND removed_at IS NULL FOR UPDATE', [
              body.swap.remove_hardware_id,
              robotId,
            ])
          ).rows[0];
          if (!removed) throw badRequest('the part to remove is not currently fitted on this robot');
          if (removed.fitted_at > body.repaired_at) throw badRequest('repair date is before the removed part was fitted');
          removedSerial ??= removed.serial_number;
          slot ??= removed.slot;
          removedModel = removed.model;
        }
        const mId = (
          await tx.query<{ id: string }>(
            `INSERT INTO maintenance_log (robot_id, repaired_at, description, part_removed_serial, part_fitted_serial, repaired_by, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [robotId, body.repaired_at, body.description, removedSerial, body.part_fitted_serial ?? null, body.repaired_by, user.id],
          )
        ).rows[0].id;
        if (removed) {
          await tx.query(`UPDATE hardware_fitted SET removed_at = $2, removal_reason = 'Replaced during repair', removed_maintenance_id = $3 WHERE id = $1`, [
            removed.id,
            body.repaired_at,
            mId,
          ]);
        }
        if (body.swap) {
          await fitPart(
            tx,
            robotId,
            { part_type_key: body.swap.part_type_key, slot, model: body.swap.model ?? removedModel, serial_number: body.part_fitted_serial ?? null, fitted_at: body.repaired_at },
            user.id,
            mId,
          );
        }
        return maintById(mId, tx);
      }),
  });
  const maintRobot = robotVia('SELECT robot_id FROM maintenance_log WHERE id = $1', 'maintenance entry');
  route(f, app, {
    method: 'PATCH',
    path: '/maintenance/:id',
    summary: 'Correct a repair entry',
    tag: 'Maintenance',
    access: { can: 'maintenance.write', target: maintRobot },
    body: maintPatch,
    handler: async ({ params, body }) => {
      const entries = Object.entries(body).filter(([, v]) => v !== undefined);
      if (entries.length) {
        const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
        await db.query(`UPDATE maintenance_log SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`, [params.id, ...entries.map(([, v]) => v)]);
      }
      return maintById(params.id, db);
    },
  });
  for (const [path, deleted] of [
    ['/maintenance/:id', true],
    ['/maintenance/:id/restore', false],
  ] as const) {
    route(f, app, {
      method: deleted ? 'DELETE' : 'POST',
      path,
      summary: deleted ? 'Soft-delete a repair entry' : 'Restore a repair entry',
      tag: 'Maintenance',
      access: { can: 'maintenance.write', target: maintRobot },
      handler: async ({ params }) => {
        const res = await db.query(`UPDATE maintenance_log SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
        if (!res.rowCount) throw conflict(deleted ? 'already deleted' : 'not deleted');
        return maintById(params.id, db);
      },
    });
  }
}
