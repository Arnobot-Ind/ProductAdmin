/**
 * Organizations: Arnobot (internal) and its customers (e.g. Adani). An organization owns robots (current
 * company_assignment_history period) and has users; customer users only ever see their organization's robots.
 */
import { withTransaction, type Queryable } from '../db';
import type { CompanyDto, OrganizationDetailDto, OrganizationDto, OrganizationRobotDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { anyScope, platform, route } from '../lib/route';
import { iso } from '../lib/sql';
import { assertUuid, includeDeleted, isoDateTime, nullableText, robotIdSchema } from '../lib/validation';
import { assignRobot } from '../services/ownership';
import { toUser, USER_SELECT } from './users';

const ORG_SELECT = `
SELECT c.id, c.name, c.kind, c.contact_name, c.contact_email, c.notes, c.created_at, c.deleted_at,
       (SELECT count(*)::int FROM company_assignment_history h JOIN robots r ON r.robot_id = h.robot_id
        WHERE h.company_id = c.id AND h.valid_to IS NULL AND r.deleted_at IS NULL) AS robot_count,
       (SELECT count(*)::int FROM users u WHERE u.company_id = c.id AND u.deleted_at IS NULL) AS user_count
FROM companies c`;
const toOrg = (r: Record<string, unknown>): OrganizationDto => ({
  ...(r as unknown as OrganizationDto),
  contact_email: (r.contact_email as string | null) ?? null,
  created_at: iso(r.created_at as Date)!,
  deleted_at: iso(r.deleted_at as Date | null),
});

const orgBody = z.object({
  name: z.string().trim().min(1).max(200),
  contact_name: nullableText(200).optional(),
  contact_email: z.preprocess((v) => (v === '' ? null : v), z.string().trim().toLowerCase().email().max(320).nullable()).optional(),
  notes: nullableText(2000).optional(),
});

export function organizationRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Organizations';
  const manage = { can: 'org.manage', target: platform() };

  const orgById = async (id: string, q: Queryable, allowDeleted = true): Promise<OrganizationDto> => {
    assertUuid(id);
    const r = (await q.query(`${ORG_SELECT} WHERE c.id = $1 ${allowDeleted ? '' : 'AND c.deleted_at IS NULL'}`, [id])).rows[0];
    if (!r) throw notFound('organization');
    return toOrg(r);
  };

  // Short list for pickers (ownership transfer, user forms). Only staff with catalogue or org rights need it.
  route(f, app, {
    method: 'GET',
    path: '/companies',
    summary: 'Organizations (short list for pickers)',
    tag,
    access: { can: 'catalog.read', target: anyScope() },
    handler: async (): Promise<CompanyDto[]> =>
      (await db.query('SELECT id, name, kind, created_at FROM companies WHERE deleted_at IS NULL ORDER BY kind, name')).rows.map((r) => ({ ...r, created_at: iso(r.created_at)! })),
  });

  route(f, app, {
    method: 'GET',
    path: '/organizations',
    summary: 'Organizations with robot and user counts',
    tag,
    access: manage,
    query: z.object(includeDeleted),
    handler: async ({ query }): Promise<OrganizationDto[]> =>
      (await db.query(`${ORG_SELECT} ${query.include_deleted ? '' : 'WHERE c.deleted_at IS NULL'} ORDER BY c.kind, c.name`)).rows.map(toOrg),
  });

  route(f, app, {
    method: 'GET',
    path: '/organizations/:id',
    summary: 'One organization: its robots (current assignments) and users',
    tag,
    access: manage,
    handler: async ({ params }): Promise<OrganizationDetailDto> => {
      const org = await orgById(params.id, db);
      const robots = (
        await db.query<OrganizationRobotDto & { assigned_since: Date }>(
          `SELECT r.robot_id, r.serial_number, p.name AS product_name, h.valid_from AS assigned_since, s.status
           FROM company_assignment_history h
           JOIN robots r ON r.robot_id = h.robot_id
           JOIN products p ON p.id = r.product_id
           JOIN v_robot_status s ON s.robot_id = r.robot_id
           WHERE h.company_id = $1 AND h.valid_to IS NULL AND r.deleted_at IS NULL
           ORDER BY r.robot_id`,
          [org.id],
        )
      ).rows.map((r) => ({ ...r, assigned_since: iso(r.assigned_since)! }));
      const users = (await db.query(`${USER_SELECT} WHERE u.company_id = $1 AND u.deleted_at IS NULL ORDER BY u.name`, [org.id])).rows.map(toUser);
      return { ...org, robots, users };
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/organizations',
    summary: 'Create a customer organization',
    tag,
    access: manage,
    status: 201,
    body: orgBody,
    handler: ({ body, user, req }) =>
      withTransaction(db, async (tx) => {
        const dup = await tx.query('SELECT 1 FROM companies WHERE lower(name) = lower($1) AND deleted_at IS NULL', [body.name]);
        if (dup.rowCount) throw conflict('an organization with this name already exists');
        const id = (
          await tx.query<{ id: string }>(
            "INSERT INTO companies (name, kind, contact_name, contact_email, notes, created_by) VALUES ($1, 'customer', $2, $3, $4, $5) RETURNING id",
            [body.name, body.contact_name ?? null, body.contact_email ?? null, body.notes ?? null, user.id],
          )
        ).rows[0].id;
        await app.audit.record({ action: 'org.created', actor: user, target: { type: 'organization', id }, companyId: id, detail: { name: body.name }, req }, tx);
        return orgById(id, tx);
      }),
  });

  route(f, app, {
    method: 'PATCH',
    path: '/organizations/:id',
    summary: 'Rename an organization or edit its contact details',
    tag,
    access: manage,
    body: orgBody.partial().strict(),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const before = await orgById(params.id, tx, false);
        if (body.name && body.name.toLowerCase() !== before.name.toLowerCase()) {
          const dup = await tx.query('SELECT 1 FROM companies WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id <> $2', [body.name, params.id]);
          if (dup.rowCount) throw conflict('an organization with this name already exists');
        }
        const sets: string[] = [];
        const values: unknown[] = [params.id];
        for (const key of ['name', 'contact_name', 'contact_email', 'notes'] as const) {
          if (body[key] !== undefined) {
            values.push(body[key]);
            sets.push(`${key} = $${values.length}`);
          }
        }
        if (sets.length) await tx.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $1`, values);
        await app.audit.record({ action: 'org.updated', actor: user, target: { type: 'organization', id: params.id }, companyId: params.id, detail: { before: { name: before.name }, changes: body }, req }, tx);
        return orgById(params.id, tx);
      }),
  });

  for (const deleted of [true, false]) {
    route(f, app, {
      method: deleted ? 'DELETE' : 'POST',
      path: deleted ? '/organizations/:id' : '/organizations/:id/restore',
      summary: deleted ? 'Delete an organization (only when it has no robots and no users)' : 'Restore a deleted organization',
      tag,
      access: manage,
      handler: ({ params, user, req }) =>
        withTransaction(db, async (tx) => {
          const org = await orgById(params.id, tx);
          if (org.kind === 'internal') throw conflict('Arnobot, the internal organization, cannot be deleted');
          if (deleted) {
            if (org.deleted_at) throw conflict('organization is already deleted');
            if (org.robot_count) throw conflict(`${org.name} still has ${org.robot_count} robot(s); assign them to another organization first`);
            if (org.user_count) throw conflict(`${org.name} still has ${org.user_count} user(s); delete them first`);
          } else if (!org.deleted_at) throw conflict('organization is not deleted');
          await tx.query(`UPDATE companies SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1`, [params.id]);
          await app.audit.record({ action: deleted ? 'org.deleted' : 'org.restored', actor: user, target: { type: 'organization', id: params.id }, companyId: params.id, detail: { name: org.name }, req }, tx);
          return orgById(params.id, tx);
        }),
    });
  }

  route(f, app, {
    method: 'POST',
    path: '/organizations/:id/robots',
    summary: 'Assign a robot to this organization (ends the previous assignment; history kept). valid_from back-dates it: the organization sees data recorded from then on',
    tag,
    access: { can: 'ownership.write', target: platform() },
    body: z.object({ robot_id: robotIdSchema, reason: nullableText(500).optional(), valid_from: isoDateTime.optional() }),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        await orgById(params.id, tx, false);
        const validFrom = body.valid_from ? new Date(body.valid_from) : undefined;
        if (validFrom && validFrom.getTime() > Date.now() + 60_000) throw badRequest('valid_from cannot be in the future');
        const result = await assignRobot(tx, app, { robotId: body.robot_id, companyId: params.id, reason: body.reason ?? null, validFrom, actor: user, req });
        return { robot_id: body.robot_id, organization_id: params.id, revoked_grants: result.revokedGrants };
      }),
  });
}
