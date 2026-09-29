import { hashPassword, passwordProblem, withTransaction, type Queryable } from '../db';
import { SCOPE_TYPES, type AccessModelDto, type RoleDto, type UserCredentialsDto, type UserDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { platform, route } from '../lib/route';
import { iso } from '../lib/sql';
import { assertUuid, includeDeleted, robotIdSchema, uuidSchema } from '../lib/validation';
import type { AuthUser } from '../services/auth.service';

export const USER_SELECT = `
SELECT u.id, u.email, u.name, u.company_id, c.name AS company_name, c.kind AS company_kind, u.is_active,
       (u.invite_token_hash IS NOT NULL AND u.password_hash IS NULL) AS invite_pending, u.invite_expires_at,
       u.must_change_password, u.last_login_at, u.created_at, u.deleted_at,
       coalesce((SELECT json_agg(json_build_object('id', g.id, 'role_key', r.key, 'role_name', r.name, 'scope_type', g.scope_type,
                                                   'scope_id', g.scope_id, 'created_at', g.created_at, 'revoked_at', g.revoked_at)
                                 ORDER BY g.created_at)
                 FROM role_grants g JOIN roles r ON r.id = g.role_id WHERE g.user_id = u.id AND g.revoked_at IS NULL), '[]') AS grants
FROM users u JOIN companies c ON c.id = u.company_id`;
export const toUser = (r: Record<string, unknown>): UserDto => ({
  ...(r as unknown as UserDto),
  email: String(r.email),
  invite_expires_at: iso(r.invite_expires_at as Date | null),
  last_login_at: iso(r.last_login_at as Date | null),
  created_at: iso(r.created_at as Date)!,
  deleted_at: iso(r.deleted_at as Date | null),
  grants: (r.grants as UserDto['grants']).map((g) => ({ ...g, created_at: iso(g.created_at)!, revoked_at: iso(g.revoked_at) })),
});

const grantBody = z.object({
  role_key: z.string().min(1).max(50),
  /** Default: platform for Arnobot staff, the user's own organization for customer users. */
  scope_type: z.enum(SCOPE_TYPES).optional(),
  scope_id: z.string().trim().max(200).nullable().optional(),
});
const credentialMethod = z.enum(['invite', 'temporary_password', 'password']);

/** 16 characters from an unambiguous alphabet (~93 bits). Shown once; the user must change it at first sign-in. */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[randomInt(alphabet.length)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
}

const isSuperAdmin = (u: AuthUser) => u.grants.some((g) => g.roleKey === 'super_admin' && g.scopeType === 'platform');

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
      ? 'SELECT 1 FROM robots WHERE robot_id = $1 AND deleted_at IS NULL'
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

  /** Arnobot-wide users (any platform grant) are managed by super-admins only. */
  const assertMayManage = (actor: AuthUser, target: UserDto) => {
    if (target.grants.some((g) => g.scope_type === 'platform') && !isSuperAdmin(actor)) {
      throw forbidden('only a super-admin can change users with platform-wide roles');
    }
  };

  /**
   * Adds one grant after the access-model rules:
   *  • the role's audience matches the user's organization (staff roles for Arnobot, customer roles for customers);
   *  • customer users stay inside their organization: their own organization, or a robot it currently owns;
   *  • customer roles are never platform-wide; platform grants are given by super-admins only.
   */
  const addGrant = async (tx: PoolClient, target: UserDto, g: z.infer<typeof grantBody>, actor: AuthUser, req: Parameters<typeof app.audit.note>[0]['req']) => {
    const role = (await tx.query<{ id: string; name: string; audience: 'staff' | 'customer' | 'any' }>('SELECT id, name, audience FROM roles WHERE key = $1', [g.role_key])).rows[0];
    if (!role) throw badRequest(`unknown role ${g.role_key}`);
    const customer = target.company_kind === 'customer';
    if (customer && role.audience === 'staff') throw badRequest(`${role.name} is an Arnobot-only role; ${target.company_name} users can be Manager or Viewer`);
    if (!customer && role.audience === 'customer') throw badRequest(`${role.name} is a customer organization role`);

    const scopeType = g.scope_type ?? (customer ? 'company' : 'platform');
    const scopeIdIn = g.scope_id ?? (customer && scopeType === 'company' ? target.company_id : null);
    if (scopeType === 'platform' && !isSuperAdmin(actor)) throw forbidden('only a super-admin can give platform-wide roles');
    const scopeId = await checkScope(tx, scopeType, scopeIdIn);

    if (customer) {
      if (scopeType === 'platform' || scopeType === 'site') throw badRequest('customer users get organization or robot scope only');
      if (scopeType === 'company' && scopeId !== target.company_id) throw badRequest(`a ${target.company_name} user can only be given access to ${target.company_name}`);
      if (scopeType === 'robot') {
        const owned = await tx.query('SELECT 1 FROM company_assignment_history WHERE robot_id = $1 AND company_id = $2 AND valid_to IS NULL', [scopeId, target.company_id]);
        if (!owned.rowCount) throw badRequest(`robot ${scopeId} is not assigned to ${target.company_name}; assign it to the organization first`);
      }
    }
    const grantId = (
      await tx.query<{ id: string }>('INSERT INTO role_grants (user_id, role_id, scope_type, scope_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
        target.id,
        role.id,
        scopeType,
        scopeId,
        actor.id,
      ])
    ).rows[0].id;
    await app.audit.record(
      {
        action: 'grant.added',
        actor,
        target: { type: 'user', id: target.id },
        companyId: target.company_id,
        robotId: scopeType === 'robot' ? scopeId : null,
        detail: { grant_id: grantId, user_email: target.email, role: g.role_key, scope_type: scopeType, scope_id: scopeId },
        req,
      },
      tx,
    );
  };

  /** Sets up how the user signs in. Returns what to show the admin once. */
  const issueCredentials = async (
    tx: PoolClient,
    userId: string,
    method: z.infer<typeof credentialMethod>,
    password: string | undefined,
  ): Promise<Omit<UserCredentialsDto, 'user'>> => {
    if (method === 'invite') {
      const inv = app.auth.newInvite();
      await tx.query('UPDATE users SET password_hash = NULL, must_change_password = false, invite_token_hash = $2, invite_expires_at = $3 WHERE id = $1', [
        userId,
        inv.hash,
        inv.expiresAt,
      ]);
      // Token in the URL fragment: never sent to a server, so it cannot land in access logs or Referer headers.
      return { invite_url: `${app.cfg.adminOrigins[0]}/invite#${inv.token}`, invite_expires_at: inv.expiresAt.toISOString(), temporary_password: null };
    }
    const pw = method === 'temporary_password' ? temporaryPassword() : (password ?? '');
    const problem = passwordProblem(pw);
    if (problem) throw badRequest(problem);
    await tx.query(
      'UPDATE users SET password_hash = $2, must_change_password = true, invite_token_hash = NULL, invite_expires_at = NULL, password_changed_at = now() WHERE id = $1',
      [userId, await hashPassword(pw)],
    );
    return { invite_url: null, invite_expires_at: null, temporary_password: method === 'temporary_password' ? pw : null };
  };

  route(f, app, {
    method: 'GET',
    path: '/roles',
    summary: 'Roles and their permissions',
    tag,
    access: manage,
    handler: async (): Promise<RoleDto[]> => (await accessModel(db)).roles,
  });

  route(f, app, {
    method: 'GET',
    path: '/access-model',
    summary: 'Every role and permission: what each role can see and do (the permission matrix)',
    tag,
    access: 'signed_in',
    handler: () => accessModel(db),
  });

  route(f, app, {
    method: 'GET',
    path: '/users',
    summary: 'Users with their organization and active grants',
    tag,
    access: manage,
    query: z.object({ ...includeDeleted, company_id: uuidSchema.optional() }),
    handler: async ({ query }): Promise<UserDto[]> => {
      const where = [query.include_deleted ? 'true' : 'u.deleted_at IS NULL', query.company_id ? 'u.company_id = $1' : 'true'];
      return (await db.query(`${USER_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.kind, c.name, u.name`, query.company_id ? [query.company_id] : [])).rows.map(toUser);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/users',
    summary: 'Create or invite a user in an organization with an initial role; returns the invitation link or temporary password once',
    tag,
    access: manage,
    status: 201,
    body: z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      name: z.string().trim().min(1).max(200),
      /** Default: Arnobot (internal). */
      company_id: uuidSchema.optional(),
      /** invite (default): the user sets their own password from a one-time link. temporary_password: generated, changed at first sign-in. */
      credentials: credentialMethod.default('invite'),
      password: z.string().max(256).optional(),
      ...grantBody.shape,
    }),
    handler: ({ body, user, req }) =>
      withTransaction(db, async (tx): Promise<UserCredentialsDto> => {
        if (body.credentials === 'password' && !body.password) throw badRequest('password is required for credentials = password');
        const exists = await tx.query('SELECT 1 FROM users WHERE email = $1 AND deleted_at IS NULL', [body.email]);
        if (exists.rowCount) throw conflict('a user with this email already exists');
        const company = (
          await tx.query<{ id: string }>(
            body.company_id ? 'SELECT id FROM companies WHERE id = $1 AND deleted_at IS NULL' : "SELECT id FROM companies WHERE kind = 'internal' AND deleted_at IS NULL",
            body.company_id ? [body.company_id] : [],
          )
        ).rows[0];
        if (!company) throw notFound('organization');
        // Placeholder invite hash satisfies the "password or invitation" check until issueCredentials runs.
        const placeholder = app.auth.newInvite();
        const id = (
          await tx.query<{ id: string }>(
            'INSERT INTO users (email, name, company_id, invite_token_hash, invite_expires_at, created_by) VALUES ($1, $2, $3, $4, now(), $5) RETURNING id',
            [body.email, body.name, company.id, placeholder.hash, user.id],
          )
        ).rows[0].id;
        const creds = await issueCredentials(tx, id, body.credentials, body.password);
        const created = await userById(id, tx);
        await app.audit.record(
          {
            action: body.credentials === 'invite' ? 'user.invited' : 'user.created',
            actor: user,
            target: { type: 'user', id },
            companyId: company.id,
            detail: { email: body.email, name: body.name, organization: created.company_name, credentials: body.credentials },
            req,
          },
          tx,
        );
        await addGrant(tx, created, body, user, req);
        return { user: await userById(id, tx), ...creds };
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/users/:id/credentials',
    summary: 'Re-issue sign-in credentials: a new invitation link or a temporary password (old password and sessions stop working)',
    tag,
    access: manage,
    body: z.object({ method: z.enum(['invite', 'temporary_password']) }),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx): Promise<UserCredentialsDto> => {
        const target = await userById(params.id, tx);
        if (target.deleted_at) throw conflict('user is deleted');
        assertMayManage(user, target);
        if (target.id === user.id) throw conflict('use My account to change your own password');
        const creds = await issueCredentials(tx, target.id, body.method, undefined);
        await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.id]);
        await app.audit.record(
          { action: body.method === 'invite' ? 'user.invited' : 'user.updated', actor: user, target: { type: 'user', id: target.id }, companyId: target.company_id, detail: { email: target.email, credentials_reissued: body.method }, req },
          tx,
        );
        return { user: await userById(target.id, tx), ...creds };
      }),
  });

  route(f, app, {
    method: 'PATCH',
    path: '/users/:id',
    summary: 'Rename, enable/disable, or set a password (a set password is temporary; disabling ends sessions)',
    tag,
    access: manage,
    body: z.object({ name: z.string().trim().min(1).max(200).optional(), is_active: z.boolean().optional(), password: z.string().max(256).optional() }).strict(),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const target = await userById(params.id, tx);
        assertMayManage(user, target);
        if (body.is_active === false) {
          if (params.id === user.id) throw conflict('you cannot disable your own account');
          await assertNotLastSuperAdmin(tx, params.id, null);
        }
        if (body.name !== undefined) await tx.query('UPDATE users SET name = $2 WHERE id = $1', [params.id, body.name]);
        if (body.is_active !== undefined) await tx.query('UPDATE users SET is_active = $2 WHERE id = $1', [params.id, body.is_active]);
        if (body.password !== undefined) {
          if (params.id === user.id) throw conflict('use My account to change your own password');
          await issueCredentials(tx, params.id, 'password', body.password);
        }
        if (body.is_active === false || body.password !== undefined) {
          await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [params.id]);
        }
        await app.audit.record(
          {
            action: 'user.updated',
            actor: user,
            target: { type: 'user', id: target.id },
            companyId: target.company_id,
            detail: { email: target.email, ...(body.name !== undefined && { name: body.name }), ...(body.is_active !== undefined && { is_active: body.is_active }), ...(body.password !== undefined && { password_reset: true }) },
            req,
          },
          tx,
        );
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
      handler: ({ params, user, req }) =>
        withTransaction(db, async (tx) => {
          const target = await userById(params.id, tx);
          assertMayManage(user, target);
          if (deleted) {
            if (params.id === user.id) throw conflict('you cannot delete your own account');
            await assertNotLastSuperAdmin(tx, params.id, null);
          }
          const res = await tx.query(`UPDATE users SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
          if (!res.rowCount) throw conflict(`user not found or already ${deleted ? 'deleted' : 'active'}`);
          if (deleted) await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [params.id]);
          await app.audit.record(
            { action: deleted ? 'user.deleted' : 'user.restored', actor: user, target: { type: 'user', id: target.id }, companyId: target.company_id, detail: { email: target.email }, req },
            tx,
          );
          return userById(params.id, tx);
        }),
    });
  }

  route(f, app, {
    method: 'POST',
    path: '/users/:id/grants',
    summary: 'Grant a role at a scope (platform / organization / site / robot)',
    tag,
    access: manage,
    status: 201,
    body: grantBody,
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const target = await userById(params.id, tx);
        if (target.deleted_at) throw conflict('user is deleted');
        assertMayManage(user, target);
        await addGrant(tx, target, body, user, req);
        return userById(params.id, tx);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/grants/:id/revoke',
    summary: 'Revoke a role grant',
    tag,
    access: manage,
    handler: ({ params, user, req }) =>
      withTransaction(db, async (tx) => {
        assertUuid(params.id);
        const g = (
          await tx.query<{ user_id: string; key: string; scope_type: string; scope_id: string | null }>(
            'SELECT g.user_id, r.key, g.scope_type, g.scope_id FROM role_grants g JOIN roles r ON r.id = g.role_id WHERE g.id = $1 AND g.revoked_at IS NULL',
            [params.id],
          )
        ).rows[0];
        if (!g) throw conflict('grant not found or already revoked');
        if (g.scope_type === 'platform' && !isSuperAdmin(user)) throw forbidden('only a super-admin can revoke platform-wide roles');
        if (g.key === 'super_admin' && g.scope_type === 'platform') await assertNotLastSuperAdmin(tx, null, params.id);
        await tx.query('UPDATE role_grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [params.id, user.id]);
        const target = await userById(g.user_id, tx);
        await app.audit.record(
          {
            action: 'grant.revoked',
            actor: user,
            target: { type: 'user', id: g.user_id },
            companyId: target.company_id,
            robotId: g.scope_type === 'robot' ? g.scope_id : null,
            detail: { grant_id: params.id, user_email: target.email, role: g.key, scope_type: g.scope_type, scope_id: g.scope_id },
            req,
          },
          tx,
        );
        return target;
      }),
  });
}

async function accessModel(db: Queryable): Promise<AccessModelDto> {
  const roles = (
    await db.query<RoleDto>(
      `SELECT r.id, r.key, r.name, r.description, r.audience,
              coalesce(array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
       GROUP BY r.id ORDER BY r.sort_order, r.name`,
    )
  ).rows;
  const permissions = (await db.query<{ key: string; description: string }>('SELECT key, description FROM permissions ORDER BY key')).rows;
  return { roles, permissions };
}
