import { hashPassword, passwordProblem, withTransaction, type Queryable } from '../db';
import { SCOPE_TYPES, type RoleDto, type UserDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { platform, route } from '../lib/route';
import { iso } from '../lib/sql';
import { assertUuid, includeDeleted, robotIdSchema, uuidSchema } from '../lib/validation';

const USER_SELECT = `
SELECT u.id, u.email, u.name, u.is_active, u.last_login_at, u.created_at, u.deleted_at,
       coalesce((SELECT json_agg(json_build_object('id', g.id, 'role_key', r.key, 'role_name', r.name, 'scope_type', g.scope_type,
                                                   'scope_id', g.scope_id, 'created_at', g.created_at, 'revoked_at', g.revoked_at)
                                 ORDER BY g.created_at)
                 FROM role_grants g JOIN roles r ON r.id = g.role_id WHERE g.user_id = u.id AND g.revoked_at IS NULL), '[]') AS grants
FROM users u`;
const toUser = (r: Record<string, unknown>): UserDto => ({
  ...(r as unknown as UserDto),
  email: String(r.email),
  last_login_at: iso(r.last_login_at as Date | null),
  created_at: iso(r.created_at as Date)!,
  deleted_at: iso(r.deleted_at as Date | null),
  grants: (r.grants as UserDto['grants']).map((g) => ({ ...g, created_at: iso(g.created_at)!, revoked_at: iso(g.revoked_at) })),
});

const grantBody = z.object({
  role_key: z.string().min(1).max(50),
  scope_type: z.enum(SCOPE_TYPES).default('platform'),
  scope_id: z.string().trim().max(200).nullable().optional(),
});

/** Validates that a grant's scope points at something that exists (spec §12 scopes). */
async function checkScope(q: Queryable, scopeType: string, scopeId: string | null | undefined): Promise<string | null> {
  if (scopeType === 'platform') {
    if (scopeId) throw badRequest('platform grants have no scope_id');
    return null;
  }
  if (!scopeId) throw badRequest(`${scopeType} grants need a scope_id`);
  const idOk = scopeType === 'robot' ? robotIdSchema.safeParse(scopeId).success : uuidSchema.safeParse(scopeId).success;
  if (!idOk) throw badRequest(`invalid ${scopeType} id`);
  const sql =
    scopeType === 'robot'
      ? 'SELECT 1 FROM robots WHERE robot_id = $1'
      : scopeType === 'company'
        ? 'SELECT 1 FROM companies WHERE id = $1 AND deleted_at IS NULL'
        : 'SELECT 1 FROM sites WHERE id = $1 AND deleted_at IS NULL';
  if (!(await q.query(sql, [scopeId])).rowCount) throw badRequest(`${scopeType} ${scopeId} does not exist`);
  return scopeId;
}

/** Refuses a change that would leave nobody able to manage users. */
async function assertNotLastSuperAdmin(tx: PoolClient, userId: string | null, grantId: string | null): Promise<void> {
  const others = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM role_grants g JOIN roles r ON r.id = g.role_id JOIN users u ON u.id = g.user_id
     WHERE r.key = 'super_admin' AND g.scope_type = 'platform' AND g.revoked_at IS NULL
       AND u.is_active AND u.deleted_at IS NULL
       AND ($1::uuid IS NULL OR g.user_id <> $1) AND ($2::uuid IS NULL OR g.id <> $2)`,
    [userId, grantId],
  );
  if (others.rows[0].n === 0) throw conflict('this would remove the last active super-admin');
}

export function userRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Users';
  const manage = { can: 'user.manage', target: platform() };

  const userById = async (id: string, q: Queryable) => {
    assertUuid(id);
    const r = (await q.query(`${USER_SELECT} WHERE u.id = $1`, [id])).rows[0];
    if (!r) throw notFound('user');
    return toUser(r);
  };
  const addGrant = async (tx: PoolClient, userId: string, g: z.infer<typeof grantBody>, by: string) => {
    const role = (await tx.query<{ id: string }>('SELECT id FROM roles WHERE key = $1', [g.role_key])).rows[0];
    if (!role) throw badRequest(`unknown role ${g.role_key}`);
    const scopeId = await checkScope(tx, g.scope_type, g.scope_id);
    await tx.query('INSERT INTO role_grants (user_id, role_id, scope_type, scope_id, created_by) VALUES ($1, $2, $3, $4, $5)', [userId, role.id, g.scope_type, scopeId, by]);
  };

  route(f, app, {
    method: 'GET',
    path: '/roles',
    summary: 'Roles and their permissions',
    tag,
    access: manage,
    handler: async (): Promise<RoleDto[]> =>
      (
        await db.query(
          `SELECT r.id, r.key, r.name, r.description,
                  coalesce(array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
           GROUP BY r.id ORDER BY count(p.key) DESC`,
        )
      ).rows,
  });

  route(f, app, {
    method: 'GET',
    path: '/users',
    summary: 'Users with their active grants',
    tag,
    access: manage,
    query: z.object(includeDeleted),
    handler: async ({ query }): Promise<UserDto[]> =>
      (await db.query(`${USER_SELECT} ${query.include_deleted ? '' : 'WHERE u.deleted_at IS NULL'} ORDER BY u.name`)).rows.map(toUser),
  });

  route(f, app, {
    method: 'POST',
    path: '/users',
    summary: 'Create a user with an initial role grant',
    tag,
    access: manage,
    status: 201,
    body: z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      name: z.string().trim().min(1).max(200),
      password: z.string().max(256),
      ...grantBody.shape,
    }),
    handler: ({ body, user }) =>
      withTransaction(db, async (tx) => {
        const problem = passwordProblem(body.password);
        if (problem) throw badRequest(problem);
        const exists = await tx.query('SELECT 1 FROM users WHERE email = $1 AND deleted_at IS NULL', [body.email]);
        if (exists.rowCount) throw conflict('a user with this email already exists');
        const id = (
          await tx.query<{ id: string }>('INSERT INTO users (email, name, password_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
            body.email,
            body.name,
            await hashPassword(body.password),
            user.id,
          ])
        ).rows[0].id;
        await addGrant(tx, id, body, user.id);
        return userById(id, tx);
      }),
  });

  route(f, app, {
    method: 'PATCH',
    path: '/users/:id',
    summary: 'Rename, enable/disable, or reset password (disabling ends sessions)',
    tag,
    access: manage,
    body: z.object({ name: z.string().trim().min(1).max(200).optional(), is_active: z.boolean().optional(), password: z.string().max(256).optional() }).strict(),
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        await userById(params.id, tx);
        if (body.is_active === false) {
          if (params.id === user.id) throw conflict('you cannot disable your own account');
          await assertNotLastSuperAdmin(tx, params.id, null);
        }
        if (body.name !== undefined) await tx.query('UPDATE users SET name = $2 WHERE id = $1', [params.id, body.name]);
        if (body.is_active !== undefined) await tx.query('UPDATE users SET is_active = $2 WHERE id = $1', [params.id, body.is_active]);
        if (body.password !== undefined) {
          const problem = passwordProblem(body.password);
          if (problem) throw badRequest(problem);
          await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [params.id, await hashPassword(body.password)]);
        }
        if (body.is_active === false || body.password !== undefined) {
          await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [params.id]);
        }
        return userById(params.id, tx);
      }),
  });

  for (const deleted of [true, false]) {
    route(f, app, {
      method: deleted ? 'DELETE' : 'POST',
      path: deleted ? '/users/:id' : '/users/:id/restore',
      summary: deleted ? 'Soft-delete a user (ends their sessions)' : 'Restore a user',
      tag,
      access: manage,
      handler: ({ params, user }) =>
        withTransaction(db, async (tx) => {
          assertUuid(params.id);
          if (deleted) {
            if (params.id === user.id) throw conflict('you cannot delete your own account');
            await assertNotLastSuperAdmin(tx, params.id, null);
          }
          const res = await tx.query(`UPDATE users SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
          if (!res.rowCount) throw conflict(`user not found or already ${deleted ? 'deleted' : 'active'}`);
          if (deleted) await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [params.id]);
          return userById(params.id, tx);
        }),
    });
  }

  route(f, app, {
    method: 'POST',
    path: '/users/:id/grants',
    summary: 'Grant a role at a scope (platform / company / site / robot)',
    tag,
    access: manage,
    status: 201,
    body: grantBody,
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        await userById(params.id, tx);
        await addGrant(tx, params.id, body, user.id);
        return userById(params.id, tx);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/grants/:id/revoke',
    summary: 'Revoke a role grant',
    tag,
    access: manage,
    handler: ({ params, user }) =>
      withTransaction(db, async (tx) => {
        assertUuid(params.id);
        const g = (await tx.query<{ user_id: string; key: string; scope_type: string }>('SELECT g.user_id, r.key, g.scope_type FROM role_grants g JOIN roles r ON r.id = g.role_id WHERE g.id = $1 AND g.revoked_at IS NULL', [params.id])).rows[0];
        if (!g) throw conflict('grant not found or already revoked');
        if (g.key === 'super_admin' && g.scope_type === 'platform') await assertNotLastSuperAdmin(tx, null, params.id);
        await tx.query('UPDATE role_grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [params.id, user.id]);
        return userById(g.user_id, tx);
      }),
  });
}
