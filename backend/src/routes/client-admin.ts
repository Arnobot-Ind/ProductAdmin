/**
 * Client admin for Arnobot staff (0021): a customer organization's profile, client-app features, the Arnobot software
 * it runs (licences) and the credentials Arnobot holds for it. Users, their robots and features are in users.ts;
 * robot assignment in organizations.ts. Every route here is platform-scoped staff work: customers never reach it.
 */
import { withTransaction, type Queryable } from '../db';
import { CLIENT_CREDENTIAL_KINDS, CLIENT_STATUSES, SOFTWARE_KINDS, type ClientCredentialDto, type ClientCredentialRevealDto, type ClientFeatureDto, type ClientProfileDto, type SoftwareInstallDto, type SoftwareProductDto, type UserRefDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { anyScope, platform, route } from '../lib/route';
import { iso } from '../lib/sql';
import { assertUuid, includeDeleted, isoDate, nullableText, optionalBool, robotIdSchema, uuidSchema } from '../lib/validation';
import { clientProfile, featureCatalogue, INSTALL_SELECT, setCompanyFeatures, toInstall } from '../services/client-admin';

const nullableDate = z.preprocess((v) => (v === '' ? null : v), isoDate.nullable());
const profileBody = z
  .object({
    client_code: z.preprocess((v) => (v === '' ? null : typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, '2–32 letters, digits, - or _').nullable()),
    status: z.enum(CLIENT_STATUSES),
    legal_name: nullableText(300),
    industry: nullableText(200),
    phone: nullableText(50),
    address: nullableText(1000),
    gstin: z.preprocess((v) => (v === '' ? null : typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[0-9A-Z]{15}$/, 'GSTIN is 15 letters/digits').nullable()),
    billing_email: z.preprocess((v) => (v === '' ? null : v), z.string().trim().toLowerCase().email().max(320).nullable()),
    account_manager_id: uuidSchema.nullable(),
    contract_start: nullableDate,
    contract_end: nullableDate,
    data_history_days: z.coerce.number().int().min(1).max(36500).nullable(),
    data_from: nullableDate,
  })
  .partial()
  .strict();

const productBody = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and _').max(64),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(SOFTWARE_KINDS),
  description: nullableText(2000).optional(),
  latest_version: nullableText(64).optional(),
});
const installBody = z.object({
  software_id: uuidSchema,
  robot_id: robotIdSchema.nullable().optional(),
  version: z.string().trim().min(1).max(64),
  host_label: nullableText(200).optional(),
  seats: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  installed_at: nullableDate.optional(),
  licence_valid_until: nullableDate.optional(),
  notes: nullableText(2000).optional(),
});

const secretField = z.string().min(1).max(16_384);
const credentialBody = z.object({
  kind: z.enum(CLIENT_CREDENTIAL_KINDS),
  label: z.string().trim().min(1).max(200),
  username: nullableText(200).optional(),
  url: z.preprocess((v) => (v === '' ? null : v), z.string().trim().url().max(2000).refine((u) => !/:\/\/[^/]*@/.test(u), 'no user name or password inside the URL').nullable()).optional(),
  robot_id: robotIdSchema.nullable().optional(),
  notes: nullableText(2000).optional(),
  secret: secretField,
});

/** Metadata only: ciphertext / iv / auth_tag are never selected here. */
const CRED_SELECT = `
SELECT c.id, c.company_id, c.kind, c.label, c.username, c.url, c.robot_id, c.notes, c.key_version, c.created_at,
       u.name AS created_by_name, c.rotated_from_id, c.revoked_at, c.revoke_reason
FROM client_credentials c LEFT JOIN users u ON u.id = c.created_by`;
const toCred = (r: Record<string, unknown>): ClientCredentialDto => ({
  ...(r as unknown as ClientCredentialDto),
  created_at: iso(r.created_at as Date)!,
  revoked_at: iso(r.revoked_at as Date | null),
});

const PRODUCT_SELECT = `
SELECT s.id, s.code, s.name, s.kind, s.description, s.latest_version, s.created_at, s.deleted_at,
       (SELECT count(*)::int FROM software_installs i WHERE i.software_id = s.id AND i.deleted_at IS NULL) AS install_count
FROM software_products s`;
const toProduct = (r: Record<string, unknown>): SoftwareProductDto => ({
  ...(r as unknown as SoftwareProductDto),
  created_at: iso(r.created_at as Date)!,
  deleted_at: iso(r.deleted_at as Date | null),
});

export function clientAdminRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, cipher } = app;
  const tag = 'Client admin';
  const manage = { can: 'org.manage', target: platform() };

  /** A customer organization (404 for Arnobot and unknown ids: clients are customers only). */
  const customer = async (id: string, q: Queryable, allowDeleted = false): Promise<{ id: string; name: string }> => {
    assertUuid(id);
    const r = (await q.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE id = $1 AND kind = 'customer' ${allowDeleted ? '' : 'AND deleted_at IS NULL'}`, [id])).rows[0];
    if (!r) throw notFound('client organization');
    return r;
  };
  const assertRobotOfClient = async (q: Queryable, companyId: string, robotId: string | null | undefined) => {
    if (!robotId) return;
    const owned = await q.query('SELECT 1 FROM company_assignment_history WHERE robot_id = $1 AND company_id = $2 AND valid_to IS NULL', [robotId, companyId]);
    if (!owned.rowCount) throw badRequest(`robot ${robotId} is not assigned to this organization`);
  };

  // ── feature catalogue ─────────────────────────────────────────────────────
  route(f, app, {
    method: 'GET',
    path: '/client-features',
    summary: 'Client-app features an organization or user can be given (catalogue)',
    tag,
    // Arnobot staff set them per organization, customer Managers per user.
    access: { can: ['org.manage', 'user.manage', 'user.invite'], target: anyScope() },
    handler: (): Promise<ClientFeatureDto[]> => featureCatalogue(db),
  });

  // ── profile ───────────────────────────────────────────────────────────────
  route(f, app, {
    method: 'PATCH',
    path: '/organizations/:id/profile',
    summary: 'Edit a client profile: status, contract, account manager, data history limit. Suspended or ended clients cannot sign in',
    tag,
    access: manage,
    body: profileBody,
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx): Promise<ClientProfileDto> => {
        const org = await customer(params.id, tx);
        const before = await clientProfile(tx, org.id);
        if (body.account_manager_id) {
          const am = await tx.query("SELECT 1 FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1 AND c.kind = 'internal' AND u.deleted_at IS NULL", [body.account_manager_id]);
          if (!am.rowCount) throw badRequest('the account manager must be an Arnobot user');
        }
        const start = body.contract_start !== undefined ? body.contract_start : before.contract_start;
        const end = body.contract_end !== undefined ? body.contract_end : before.contract_end;
        if (start && end && end < start) throw badRequest('the contract cannot end before it starts');
        if (body.client_code) {
          const dup = await tx.query('SELECT 1 FROM client_profiles WHERE client_code = $1 AND company_id <> $2', [body.client_code, org.id]);
          if (dup.rowCount) throw conflict(`client code ${body.client_code} is already used`);
        }
        await tx.query('INSERT INTO client_profiles (company_id, created_by, updated_by) VALUES ($1, $2, $2) ON CONFLICT (company_id) DO NOTHING', [org.id, user.id]);
        const sets: string[] = ['updated_by = $2'];
        const values: unknown[] = [org.id, user.id];
        for (const [k, v] of Object.entries(body)) {
          values.push(v);
          sets.push(`${k} = $${values.length}`);
        }
        await tx.query(`UPDATE client_profiles SET ${sets.join(', ')} WHERE company_id = $1`, values);
        if (body.status && ['suspended', 'ended'].includes(body.status) && body.status !== before.status) {
          // Sessions are refused from now on anyway; ending them also stops live updates at once.
          await tx.query('UPDATE sessions s SET revoked_at = now() FROM users u WHERE s.user_id = u.id AND u.company_id = $1 AND s.revoked_at IS NULL', [org.id]);
        }
        await app.audit.record(
          { action: 'client.updated', actor: user, target: { type: 'organization', id: org.id }, companyId: org.id, detail: { organization: org.name, changes: body, before_status: before.status }, req },
          tx,
        );
        return clientProfile(tx, org.id);
      }),
  });

  route(f, app, {
    method: 'GET',
    path: '/account-managers',
    summary: 'Arnobot users who can be a client account manager',
    tag,
    access: manage,
    handler: async (): Promise<UserRefDto[]> =>
      (
        await db.query<UserRefDto>(
          "SELECT u.id, u.name, u.email FROM users u JOIN companies c ON c.id = u.company_id WHERE c.kind = 'internal' AND u.deleted_at IS NULL AND u.is_active ORDER BY u.name",
        )
      ).rows,
  });

  // ── features ──────────────────────────────────────────────────────────────
  route(f, app, {
    method: 'PUT',
    path: '/organizations/:id/features',
    summary: "Set an organization's client-app features. Removed ones are taken from its users; add_to_users also gives the new ones to every user",
    tag,
    access: manage,
    body: z.object({ features: z.array(z.string().max(100)).max(200), add_to_users: z.boolean().default(true) }),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const org = await customer(params.id, tx);
        const diff = await setCompanyFeatures(tx, app, { companyId: org.id, keys: body.features, addToUsers: body.add_to_users, actor: user, req });
        return { ...diff, features: (await tx.query<{ k: string }>('SELECT feature_key AS k FROM company_features WHERE company_id = $1 AND revoked_at IS NULL ORDER BY 1', [org.id])).rows.map((r) => r.k) };
      }),
  });

  // ── software catalogue ────────────────────────────────────────────────────
  route(f, app, {
    method: 'GET',
    path: '/software-products',
    summary: 'Arnobot software that can be installed at clients',
    tag,
    access: manage,
    query: z.object(includeDeleted),
    handler: async ({ query }): Promise<SoftwareProductDto[]> =>
      (await db.query(`${PRODUCT_SELECT} ${query.include_deleted ? '' : 'WHERE s.deleted_at IS NULL'} ORDER BY s.deleted_at NULLS FIRST, s.name`)).rows.map(toProduct),
  });

  const productById = async (id: string, q: Queryable) => {
    assertUuid(id);
    const r = (await q.query(`${PRODUCT_SELECT} WHERE s.id = $1`, [id])).rows[0];
    if (!r) throw notFound('software');
    return toProduct(r);
  };

  route(f, app, {
    method: 'POST',
    path: '/software-products',
    summary: 'Add software to the catalogue (its code can never change or be reused)',
    tag,
    access: manage,
    status: 201,
    body: productBody,
    handler: ({ body, user, req }) =>
      withTransaction(db, async (tx) => {
        if ((await tx.query('SELECT 1 FROM software_products WHERE code = $1', [body.code])).rowCount) throw conflict(`software code ${body.code} is already used`);
        const id = (
          await tx.query<{ id: string }>('INSERT INTO software_products (code, name, kind, description, latest_version, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
            body.code,
            body.name,
            body.kind,
            body.description ?? null,
            body.latest_version ?? null,
            user.id,
          ])
        ).rows[0].id;
        await app.audit.record({ action: 'catalog.software_created', actor: user, target: { type: 'software', id }, detail: { code: body.code, name: body.name }, req }, tx);
        return productById(id, tx);
      }),
  });

  route(f, app, {
    method: 'PATCH',
    path: '/software-products/:id',
    summary: 'Edit catalogue software (name, kind, description, latest version)',
    tag,
    access: manage,
    body: productBody.omit({ code: true }).partial().strict(),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const before = await productById(params.id, tx);
        if (before.deleted_at) throw conflict('software is deleted; restore it first');
        const sets: string[] = [];
        const values: unknown[] = [params.id];
        for (const [k, v] of Object.entries(body)) {
          values.push(v);
          sets.push(`${k} = $${values.length}`);
        }
        if (sets.length) await tx.query(`UPDATE software_products SET ${sets.join(', ')} WHERE id = $1`, values);
        await app.audit.record({ action: 'catalog.software_updated', actor: user, target: { type: 'software', id: params.id }, detail: { code: before.code, changes: body }, req }, tx);
        return productById(params.id, tx);
      }),
  });

  for (const deleted of [true, false]) {
    route(f, app, {
      method: deleted ? 'DELETE' : 'POST',
      path: deleted ? '/software-products/:id' : '/software-products/:id/restore',
      summary: deleted ? 'Delete catalogue software (refused while a client still has it installed)' : 'Restore deleted catalogue software',
      tag,
      access: manage,
      handler: ({ params, user, req }) =>
        withTransaction(db, async (tx) => {
          const p = await productById(params.id, tx);
          if (deleted && p.install_count) throw conflict(`${p.name} is installed at ${p.install_count} place(s); remove those installs first`);
          const res = await tx.query(`UPDATE software_products SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = $1 AND deleted_at IS ${deleted ? '' : 'NOT'} NULL`, [params.id]);
          if (!res.rowCount) throw conflict(`software is ${deleted ? 'already deleted' : 'not deleted'}`);
          await app.audit.record({ action: deleted ? 'catalog.software_deleted' : 'catalog.software_restored', actor: user, target: { type: 'software', id: params.id }, detail: { code: p.code }, req }, tx);
          return productById(params.id, tx);
        }),
    });
  }

  // ── software installs ─────────────────────────────────────────────────────
  const installById = async (id: string, q: Queryable): Promise<SoftwareInstallDto> => {
    assertUuid(id);
    const r = (await q.query(`${INSTALL_SELECT} WHERE i.id = $1 AND i.deleted_at IS NULL`, [id])).rows[0];
    if (!r) throw notFound('software install');
    return toInstall(r);
  };

  route(f, app, {
    method: 'GET',
    path: '/organizations/:id/software',
    summary: "A client's software installs and licences",
    tag,
    access: manage,
    handler: async ({ params }): Promise<SoftwareInstallDto[]> => {
      const org = await customer(params.id, db, true);
      return (await db.query(`${INSTALL_SELECT} WHERE i.company_id = $1 AND i.deleted_at IS NULL ORDER BY s.name, i.robot_id NULLS FIRST, i.host_label`, [org.id])).rows.map(toInstall);
    },
  });

  const checkInstall = async (tx: PoolClient, companyId: string, b: Partial<z.infer<typeof installBody>>) => {
    if (b.software_id) {
      const s = await tx.query('SELECT 1 FROM software_products WHERE id = $1 AND deleted_at IS NULL', [b.software_id]);
      if (!s.rowCount) throw badRequest('unknown software');
    }
    await assertRobotOfClient(tx, companyId, b.robot_id);
  };

  route(f, app, {
    method: 'POST',
    path: '/organizations/:id/software',
    summary: 'Record software installed at a client (optionally on one of its robots)',
    tag,
    access: manage,
    status: 201,
    body: installBody,
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const org = await customer(params.id, tx);
        await checkInstall(tx, org.id, body);
        const id = (
          await tx.query<{ id: string }>(
            `INSERT INTO software_installs (company_id, software_id, robot_id, version, host_label, seats, installed_at, licence_valid_until, notes, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
            [org.id, body.software_id, body.robot_id ?? null, body.version, body.host_label ?? null, body.seats ?? null, body.installed_at ?? null, body.licence_valid_until ?? null, body.notes ?? null, user.id],
          )
        ).rows[0].id;
        const created = await installById(id, tx);
        await app.audit.record(
          { action: 'software.installed', actor: user, target: { type: 'software_install', id }, companyId: org.id, robotId: created.robot_id, detail: { software: created.software.code, version: created.version }, req },
          tx,
        );
        return created;
      }),
  });

  route(f, app, {
    method: 'PATCH',
    path: '/software-installs/:id',
    summary: 'Edit a software install (version, licence, robot, seats, notes)',
    tag,
    access: manage,
    body: installBody.partial().strict(),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const before = await installById(params.id, tx);
        await checkInstall(tx, before.company_id, body);
        const sets: string[] = ['updated_by = $2'];
        const values: unknown[] = [params.id, user.id];
        for (const [k, v] of Object.entries(body)) {
          values.push(v);
          sets.push(`${k} = $${values.length}`);
        }
        await tx.query(`UPDATE software_installs SET ${sets.join(', ')} WHERE id = $1`, values);
        const after = await installById(params.id, tx);
        await app.audit.record(
          {
            action: 'software.updated',
            actor: user,
            target: { type: 'software_install', id: params.id },
            companyId: before.company_id,
            robotId: after.robot_id,
            detail: { software: after.software.code, from_version: before.version, changes: body },
            req,
          },
          tx,
        );
        return after;
      }),
  });

  route(f, app, {
    method: 'DELETE',
    path: '/software-installs/:id',
    summary: 'Remove a software install (kept in history)',
    tag,
    access: manage,
    handler: ({ params, user, req }) =>
      withTransaction(db, async (tx) => {
        const before = await installById(params.id, tx);
        await tx.query('UPDATE software_installs SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [params.id, user.id]);
        await app.audit.record(
          { action: 'software.removed', actor: user, target: { type: 'software_install', id: params.id }, companyId: before.company_id, robotId: before.robot_id, detail: { software: before.software.code, version: before.version }, req },
          tx,
        );
      }),
  });

  // ── client credentials ────────────────────────────────────────────────────
  const credById = async (id: string, q: Queryable) => {
    assertUuid(id);
    const r = (await q.query(`${CRED_SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!r) throw notFound('credential');
    return toCred(r);
  };

  route(f, app, {
    method: 'GET',
    path: '/organizations/:id/credentials',
    summary: "Credentials Arnobot holds for a client (metadata only, never the secret)",
    tag,
    access: { can: 'credential.read_meta', target: platform() },
    query: z.object({ include_revoked: optionalBool }),
    handler: async ({ params, query }): Promise<ClientCredentialDto[]> => {
      const org = await customer(params.id, db, true);
      return (await db.query(`${CRED_SELECT} WHERE c.company_id = $1 ${query.include_revoked ? '' : 'AND c.revoked_at IS NULL'} ORDER BY c.revoked_at NULLS FIRST, c.kind, c.label`, [org.id])).rows.map(toCred);
    },
  });

  const insertCredential = async (
    tx: PoolClient,
    companyId: string,
    b: { kind: string; label: string; username: string | null; url: string | null; robot_id: string | null; notes: string | null; secret: string },
    actorId: string,
    rotatedFrom: string | null,
  ): Promise<string> => {
    const id = randomUUID();
    const enc = cipher.encrypt(b.secret, { credentialId: id, companyId, kind: b.kind });
    await tx.query(
      `INSERT INTO client_credentials (id, company_id, kind, label, username, url, robot_id, notes, ciphertext, iv, auth_tag, key_version, rotated_from_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, companyId, b.kind, b.label, b.username, b.url, b.robot_id, b.notes, enc.ciphertext, enc.iv, enc.authTag, enc.keyVersion, rotatedFrom, actorId],
    );
    return id;
  };

  route(f, app, {
    method: 'POST',
    path: '/organizations/:id/credentials',
    summary: 'Store a credential for a client (encrypted; the secret is typed once)',
    tag,
    access: { can: 'credential.write', target: platform() },
    status: 201,
    body: credentialBody,
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const org = await customer(params.id, tx);
        await assertRobotOfClient(tx, org.id, body.robot_id);
        const id = await insertCredential(
          tx,
          org.id,
          { kind: body.kind, label: body.label, username: body.username ?? null, url: body.url ?? null, robot_id: body.robot_id ?? null, notes: body.notes ?? null, secret: body.secret },
          user.id,
          null,
        );
        await app.audit.record({ action: 'credential.created', actor: user, target: { type: 'client_credential', id }, companyId: org.id, detail: { kind: body.kind, label: body.label }, req }, tx);
        return credById(id, tx);
      }),
  });

  type SecretRow = { id: string; company_id: string; kind: ClientCredentialRevealDto['kind']; label: string; username: string | null; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; revoked_at: Date | null };

  route(f, app, {
    method: 'POST',
    path: '/client-credentials/:id/reveal',
    summary: 'Decrypt one client secret (audited, never cached)',
    tag,
    access: { can: 'credential.reveal', target: platform() },
    handler: async ({ params, reply, user, req }): Promise<ClientCredentialRevealDto> => {
      assertUuid(params.id);
      const r = (await db.query<SecretRow>('SELECT id, company_id, kind, label, username, ciphertext, iv, auth_tag, key_version, revoked_at FROM client_credentials WHERE id = $1', [params.id])).rows[0];
      if (!r) throw notFound('credential');
      if (r.revoked_at) throw conflict('credential is revoked');
      const secret = cipher.decrypt({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag, keyVersion: r.key_version }, { credentialId: r.id, companyId: r.company_id, kind: r.kind });
      await app.audit.record({ action: 'credential.revealed', actor: user, target: { type: 'client_credential', id: r.id }, companyId: r.company_id, detail: { kind: r.kind, label: r.label }, req });
      reply.header('Cache-Control', 'no-store, max-age=0').header('Pragma', 'no-cache');
      return { id: r.id, kind: r.kind, label: r.label, username: r.username, secret };
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/client-credentials/:id/rotate',
    summary: 'Rotate a client secret: revoke the current one and store the replacement (history kept)',
    tag,
    access: { can: 'credential.write', target: platform() },
    body: z.object({ secret: secretField, username: nullableText(200).optional(), label: z.string().trim().min(1).max(200).optional() }),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        assertUuid(params.id);
        const old = (
          await tx.query<{ company_id: string; kind: string; label: string; username: string | null; url: string | null; robot_id: string | null; notes: string | null; revoked_at: Date | null }>(
            'SELECT company_id, kind, label, username, url, robot_id, notes, revoked_at FROM client_credentials WHERE id = $1 FOR UPDATE',
            [params.id],
          )
        ).rows[0];
        if (!old) throw notFound('credential');
        if (old.revoked_at) throw conflict('credential is already revoked; add a new one instead');
        await tx.query("UPDATE client_credentials SET revoked_at = now(), revoked_by = $2, revoke_reason = 'rotated' WHERE id = $1", [params.id, user.id]);
        const id = await insertCredential(
          tx,
          old.company_id,
          { ...old, label: body.label ?? old.label, username: body.username !== undefined ? body.username : old.username, secret: body.secret },
          user.id,
          params.id,
        );
        await app.audit.record({ action: 'credential.rotated', actor: user, target: { type: 'client_credential', id }, companyId: old.company_id, detail: { kind: old.kind, label: body.label ?? old.label, rotated_from: params.id }, req }, tx);
        return credById(id, tx);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/client-credentials/:id/revoke',
    summary: 'Revoke a client secret (row kept, secret no longer revealable)',
    tag,
    access: { can: 'credential.write', target: platform() },
    body: z.object({ reason: z.string().trim().min(1).max(500) }),
    handler: ({ params, body, user, req }) =>
      withTransaction(db, async (tx) => {
        const before = await credById(params.id, tx);
        if (before.revoked_at) throw conflict('credential is already revoked');
        await tx.query('UPDATE client_credentials SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1', [params.id, user.id, body.reason]);
        await app.audit.record({ action: 'credential.revoked', actor: user, target: { type: 'client_credential', id: params.id }, companyId: before.company_id, detail: { kind: before.kind, label: before.label, reason: body.reason }, req }, tx);
        return credById(params.id, tx);
      }),
  });
}
