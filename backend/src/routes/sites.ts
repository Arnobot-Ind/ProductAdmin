import { withTransaction, type Queryable } from '../db';
import type { RobotDeploymentDto, SiteDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { anyScope, platform, robotParam, robotVia, route } from '../lib/route';
import { iso, Where } from '../lib/sql';
import { assertUuid, includeDeleted, isoDateTime, nullableText, uuidSchema } from '../lib/validation';

const SITE_SELECT = `
SELECT s.id, s.name, s.site_no, c.org_no, s.company_id, c.name AS company_name, s.address, s.city, s.state, s.country, s.latitude, s.longitude,
       s.contact_name, s.contact_phone, s.contact_email, s.notes, s.created_at, s.deleted_at,
       (SELECT count(*)::int FROM site_assignment_history d JOIN robots r ON r.robot_id = d.robot_id
        WHERE d.site_id = s.id AND d.valid_to IS NULL AND r.deleted_at IS NULL) AS robots_now,
       (SELECT count(DISTINCT d.robot_id)::int FROM site_assignment_history d WHERE d.site_id = s.id) AS robots_ever
FROM sites s LEFT JOIN companies c ON c.id = s.company_id`;
const toSite = (r: Record<string, unknown>): SiteDto => ({ ...(r as unknown as SiteDto), created_at: iso(r.created_at as Date)!, deleted_at: iso(r.deleted_at as Date | null) });

const DEPLOYMENT_SELECT = `
SELECT d.id, d.robot_id, d.site_id, s.name AS site_name, s.city AS site_city, d.valid_from AS deployed_at, du.name AS deployed_by_name, d.purpose, d.notes,
       d.valid_to AS ended_at, eu.name AS ended_by_name, d.end_note
FROM site_assignment_history d JOIN sites s ON s.id = d.site_id
LEFT JOIN users du ON du.id = d.created_by LEFT JOIN users eu ON eu.id = d.ended_by`;
const toDeployment = (r: Record<string, unknown>): RobotDeploymentDto => ({
  ...(r as unknown as RobotDeploymentDto),
  deployed_at: iso(r.deployed_at as Date)!,
  ended_at: iso(r.ended_at as Date | null),
});

const siteBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** Whose site (0002: every site belongs to an organization). */
  company_id: uuidSchema,
  address: nullableText(500).optional(),
  city: nullableText(100).optional(),
  state: nullableText(100).optional(),
  country: nullableText(100).optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
  contact_name: nullableText(120).optional(),
  contact_phone: nullableText(40).optional(),
  contact_email: nullableText(200).optional(),
  notes: nullableText(2000).optional(),
});
const SITE_FIELDS = ['name', 'company_id', 'address', 'city', 'state', 'country', 'latitude', 'longitude', 'contact_name', 'contact_phone', 'contact_email', 'notes'] as const;

/**
 * Sites and deployments (0002 / 0004, filled in by 0026): the places robots work, and per robot the history of where
 * it was deployed and when (site_assignment_history; deploying elsewhere closes the current period, nothing is
 * deleted). Staff only, like ownership details. A site-scoped grant covers the robots deployed there now.
 */
export function siteRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Sites';
  const read = { can: 'robot.details', target: platform() };
  const write = { can: 'robot.write', target: platform() };
  const deploymentRobot = robotVia('SELECT robot_id FROM site_assignment_history WHERE id = $1', 'deployment');

  const siteById = async (id: string, q: Queryable = db) => {
    assertUuid(id);
    const r = (await q.query(`${SITE_SELECT} WHERE s.id = $1`, [id])).rows[0];
    if (!r) throw notFound('site');
    return toSite(r);
  };
  const checkBody = async (body: Partial<z.infer<typeof siteBody>>, q: Queryable, id?: string) => {
    if ((body.latitude == null) !== (body.longitude == null) && (body.latitude !== undefined || body.longitude !== undefined)) throw badRequest('give both latitude and longitude, or neither');
    if (body.company_id && !(await q.query('SELECT 1 FROM companies WHERE id = $1 AND deleted_at IS NULL', [body.company_id])).rowCount) throw notFound('organization');
    if (body.name && (await q.query('SELECT 1 FROM sites WHERE lower(name) = lower($1) AND deleted_at IS NULL AND id IS DISTINCT FROM $2', [body.name, id ?? null])).rowCount) {
      throw conflict(`a site named ${body.name} already exists`);
    }
  };

  route(f, app, {
    method: 'GET',
    path: '/sites',
    summary: 'Sites robots are deployed to, with how many robots are there now',
    tag,
    access: read,
    query: z.object({ ...includeDeleted, company: uuidSchema.optional() }),
    handler: async ({ query }): Promise<SiteDto[]> => {
      const w = new Where();
      if (!query.include_deleted) w.add('s.deleted_at IS NULL');
      if (query.company) w.add('s.company_id = ?', query.company);
      return (await db.query(`${SITE_SELECT} ${w.toSql()} ORDER BY s.deleted_at NULLS FIRST, lower(s.name)`, w.params)).rows.map(toSite);
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/sites/:id',
    summary: 'One site',
    tag,
    access: read,
    handler: ({ params }) => siteById(params.id),
  });

  route(f, app, {
    method: 'POST',
    path: '/sites',
    summary: 'Add a site',
    tag,
    access: write,
    body: siteBody,
    status: 201,
    handler: ({ body, user, req }) =>
      withTransaction(db, async (tx) => {
        await checkBody(body, tx);
        const id = (
          await tx.query<{ id: string }>(
            `INSERT INTO sites (${SITE_FIELDS.join(', ')}, created_by) VALUES (${SITE_FIELDS.map((_, i) => `$${i + 1}`).join(', ')}, $${SITE_FIELDS.length + 1}) RETURNING id`,
            [...SITE_FIELDS.map((k) => body[k] ?? null), user.id],
          )
        ).rows[0].id;
        await app.audit.record({ action: 'site.created', actor: user, target: { type: 'site', id }, companyId: body.company_id ?? null, detail: { name: body.name }, req }, tx);
        return siteById(id, tx);
      }),
  });

  route(f, app, {
    method: 'PATCH',
    path: '/sites/:id',
    summary: 'Edit a site (name, organization, address, map position, contact, notes)',
    tag,
    access: write,
    body: siteBody.partial().strict(),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const before = await siteById(params.id, tx);
        await checkBody(body, tx, params.id);
        const changed = SITE_FIELDS.filter((k) => body[k] !== undefined && body[k] !== before[k]);
        for (const k of changed) await tx.query(`UPDATE sites SET ${k} = $2 WHERE id = $1`, [params.id, body[k]]);
        if (changed.length) await app.audit.record({ action: 'site.updated', actor: user, target: { type: 'site', id: params.id }, detail: { name: before.name, fields: changed }, req }, tx);
        return siteById(params.id, tx);
      }),
  });

  for (const deleted of [true, false]) {
    route(f, app, {
      method: deleted ? 'DELETE' : 'POST',
      path: deleted ? '/sites/:id' : '/sites/:id/restore',
      summary: deleted ? 'Retire a site (only when no robot is deployed there; its history is kept)' : 'Bring a retired site back',
      tag,
      access: write,
      handler: async ({ params }) => {
        const s = await siteById(params.id);
        if (deleted && s.robots_now) throw conflict(`${s.robots_now} robot(s) are deployed at ${s.name}; move them first`);
        const res = await db.query(`UPDATE sites SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
        if (!res.rowCount) throw conflict(deleted ? 'already retired' : 'not retired');
        return siteById(params.id);
      },
    });
  }

  route(f, app, {
    method: 'GET',
    path: '/sites/:id/deployments',
    summary: 'Every robot deployed at a site, now (first) and before; limited to robots the user may see',
    tag,
    access: { can: 'robot.details', target: anyScope() },
    handler: async ({ params, user }): Promise<RobotDeploymentDto[]> => {
      await siteById(params.id);
      const w = app.perms.applyRobotScope(new Where(), app.perms.robotScope(user, 'robot.details'), 'd.robot_id');
      w.add('d.site_id = ?', params.id);
      return (await db.query(`${DEPLOYMENT_SELECT} ${w.toSql()} ORDER BY (d.valid_to IS NULL) DESC, coalesce(d.valid_to, d.valid_from) DESC LIMIT 2000`, w.params)).rows.map(toDeployment);
    },
  });

  // ── per robot ────────────────────────────────────────────────────────────
  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/deployments',
    summary: "A robot's deployments: where it is now (first), then where it was before",
    tag: 'Robots',
    access: { can: 'robot.details', target: robotParam() },
    handler: async ({ params }): Promise<RobotDeploymentDto[]> => {
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      return (await db.query(`${DEPLOYMENT_SELECT} WHERE d.robot_id = $1 ORDER BY (d.valid_to IS NULL) DESC, d.valid_from DESC`, [params.robotId])).rows.map(toDeployment);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/robots/:robotId/deployments',
    summary: 'Deploy a robot at a site; a current deployment elsewhere ends at the same moment (history kept)',
    tag: 'Robots',
    access: { can: 'robot.write', target: robotParam() },
    body: z.object({ site_id: uuidSchema, deployed_at: isoDateTime.optional(), purpose: nullableText(300).optional(), notes: nullableText(1000).optional() }),
    status: 201,
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        await app.robots.assertExists(params.robotId, {}, tx);
        const site = (await tx.query<{ name: string }>('SELECT name FROM sites WHERE id = $1 AND deleted_at IS NULL', [body.site_id])).rows[0];
        if (!site) throw notFound('site');
        const at = body.deployed_at ? new Date(body.deployed_at) : new Date();
        if (at.getTime() > Date.now() + 60_000) throw badRequest('the deployment date is in the future');
        const current = (
          await tx.query<{ id: string; site_id: string; valid_from: Date; site_name: string }>(
            'SELECT d.id, d.site_id, d.valid_from, s.name AS site_name FROM site_assignment_history d JOIN sites s ON s.id = d.site_id WHERE d.robot_id = $1 AND d.valid_to IS NULL FOR UPDATE OF d',
            [params.robotId],
          )
        ).rows[0];
        if (current?.site_id === body.site_id) throw conflict(`${params.robotId} is already deployed at ${site.name}`);
        if (current && at <= current.valid_from) throw badRequest(`the new deployment must start after the current one (${iso(current.valid_from)})`);
        // Periods never overlap (0004 exclusion constraint): a new one cannot start inside an earlier one.
        const lastEnd = (await tx.query<{ t: Date | null }>('SELECT max(valid_to) AS t FROM site_assignment_history WHERE robot_id = $1', [params.robotId])).rows[0].t;
        if (lastEnd && at < lastEnd) throw badRequest(`the robot was deployed elsewhere until ${iso(lastEnd)}; start after that`);
        if (current) {
          await tx.query('UPDATE site_assignment_history SET valid_to = $2, ended_by = $3, end_note = $4 WHERE id = $1', [current.id, at, user.id, `Moved to ${site.name}`]);
        }
        const id = (
          await tx.query<{ id: string }>('INSERT INTO site_assignment_history (robot_id, site_id, valid_from, created_by, purpose, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
            params.robotId,
            body.site_id,
            at,
            user.id,
            body.purpose ?? null,
            body.notes ?? null,
          ])
        ).rows[0].id;
        await app.audit.record(
          { action: 'robot.deployed', actor: user, target: { type: 'robot', id: params.robotId }, robotId: params.robotId, detail: { site: site.name, from_site: current?.site_name ?? null, deployed_at: at.toISOString() }, req },
          tx,
        );
        return toDeployment((await tx.query(`${DEPLOYMENT_SELECT} WHERE d.id = $1`, [id])).rows[0]);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/robot-deployments/:id/end',
    summary: 'End a deployment (the robot came back, or is not deployed anywhere now)',
    tag: 'Robots',
    access: { can: 'robot.write', target: deploymentRobot },
    body: z.object({ ended_at: isoDateTime.optional(), note: nullableText(500).optional() }),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const d = (
          await tx.query<{ robot_id: string; valid_from: Date; site_name: string }>(
            'SELECT d.robot_id, d.valid_from, s.name AS site_name FROM site_assignment_history d JOIN sites s ON s.id = d.site_id WHERE d.id = $1 AND d.valid_to IS NULL FOR UPDATE OF d',
            [params.id],
          )
        ).rows[0];
        if (!d) throw conflict('this deployment has already ended');
        const at = body.ended_at ? new Date(body.ended_at) : new Date();
        if (at <= d.valid_from) throw badRequest('the end must be after the start of the deployment');
        if (at.getTime() > Date.now() + 60_000) throw badRequest('the end date is in the future');
        await tx.query('UPDATE site_assignment_history SET valid_to = $2, ended_by = $3, end_note = $4 WHERE id = $1', [params.id, at, user.id, body.note ?? null]);
        await app.audit.record(
          { action: 'robot.deployment_ended', actor: user, target: { type: 'robot', id: d.robot_id }, robotId: d.robot_id, detail: { site: d.site_name, ended_at: at.toISOString() }, req },
          tx,
        );
        return toDeployment((await tx.query(`${DEPLOYMENT_SELECT} WHERE d.id = $1`, [params.id])).rows[0]);
      }),
  });
}
