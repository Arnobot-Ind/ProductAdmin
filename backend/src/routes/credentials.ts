import { withTransaction, type Queryable } from '../db';
import { CREDENTIAL_KINDS, PER_CAMERA_CREDENTIAL_KINDS, SSH_AUTH_METHODS, type CredentialMetaDto, type CredentialRevealDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { conflict, notFound } from '../lib/errors';
import { robotParam, robotVia, route } from '../lib/route';
import { iso } from '../lib/sql';
import { nullableText, optionalBool } from '../lib/validation';

/** Metadata columns ONLY. ciphertext / iv / auth_tag are never selected here (rule 11). */
const META_SELECT = `
SELECT c.id, c.robot_id, c.kind, c.slot, c.label, c.username, c.host, c.port, c.auth_method, c.proxy, c.key_version, c.created_at, u.name AS created_by_name,
       c.rotated_from_id, c.revoked_at, c.revoke_reason
FROM robot_credentials c LEFT JOIN users u ON u.id = c.created_by`;
const toMeta = (r: Record<string, unknown>): CredentialMetaDto => {
  const { robot_id: _robot, ...rest } = r;
  return { ...(rest as unknown as CredentialMetaDto), created_at: iso(r.created_at as Date)!, revoked_at: iso(r.revoked_at as Date | null) };
};

const secretField = z.string().min(1).max(16_384);
/** SSH connection details: not secret, shown in the list. Only for kind 'ssh'. */
const sshFields = {
  host: nullableText(253).optional(),
  port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  auth_method: z.enum(SSH_AUTH_METHODS).nullable().optional(),
  proxy: nullableText(500).optional(),
};
const createBody = z
  .object({
    kind: z.enum(CREDENTIAL_KINDS),
    slot: z.coerce.number().int().min(1).max(4).nullable().optional(),
    label: nullableText(200).optional(),
    username: nullableText(200).optional(),
    ...sshFields,
    secret: secretField,
  })
  .superRefine((v, ctx) => {
    if (v.kind !== 'ssh' && (v.host || v.port || v.auth_method || v.proxy)) ctx.addIssue({ code: 'custom', path: ['host'], message: 'host, port, auth method and proxy are only for SSH credentials' });
    if (v.kind === 'ssh' && !v.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'SSH credentials need a host' });
    const perCamera = PER_CAMERA_CREDENTIAL_KINDS.includes(v.kind);
    if (perCamera && !v.slot) ctx.addIssue({ code: 'custom', path: ['slot'], message: 'camera credentials need a camera slot 1–4' });
    if (!perCamera && v.slot) ctx.addIssue({ code: 'custom', path: ['slot'], message: 'slot is only for camera credentials' });
  });
const rotateBody = z.object({ secret: secretField, username: nullableText(200).optional(), label: nullableText(200).optional(), ...sshFields });
const revokeBody = z.object({ reason: z.string().trim().min(1).max(500) });

/**
 * Device credentials (spec §3 row 6, §10). Encrypted with AES-256-GCM (key outside the DB), stored
 * separately from `robots`. Lists return metadata only; the secret leaves the server solely through
 * the explicit, permission-gated reveal endpoint, with Cache-Control: no-store.
 */
export function credentialRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, robots, cipher } = app;
  const tag = 'Credentials';
  const credRobot = robotVia('SELECT robot_id FROM robot_credentials WHERE id = $1', 'credential');

  const metaById = async (id: string, q: Queryable) => {
    const r = (await q.query(`${META_SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!r) throw notFound('credential');
    return toMeta(r);
  };

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/credentials',
    summary: 'Credential metadata (never the secret)',
    tag,
    access: { can: 'credential.read_meta', target: robotParam() },
    query: z.object({ include_revoked: optionalBool }),
    handler: async ({ params, query }): Promise<CredentialMetaDto[]> => {
      await robots.assertExists(params.robotId, { allowDeleted: true });
      const rows = await db.query(
        `${META_SELECT} WHERE c.robot_id = $1 ${query.include_revoked ? '' : 'AND c.revoked_at IS NULL'}
         ORDER BY c.kind, c.slot NULLS FIRST, c.created_at DESC`,
        [params.robotId],
      );
      return rows.rows.map(toMeta);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/robots/:robotId/credentials',
    summary: 'Store a new credential (encrypted). One active secret per kind/slot.',
    tag,
    access: { can: 'credential.write', target: robotParam() },
    body: createBody,
    status: 201,
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        await robots.assertExists(params.robotId, {}, tx);
        const slot = body.slot ?? null;
        const enc = cipher.encrypt(body.secret, { robotId: params.robotId, kind: body.kind, slot });
        const res = await tx.query<{ id: string }>(
          `INSERT INTO robot_credentials (robot_id, kind, slot, label, username, host, port, auth_method, proxy, ciphertext, iv, auth_tag, key_version, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          [
            params.robotId,
            body.kind,
            slot,
            body.label ?? null,
            body.username ?? null,
            body.host ?? null,
            body.kind === 'ssh' ? (body.port ?? 22) : null,
            body.kind === 'ssh' ? (body.auth_method ?? 'password') : null,
            body.proxy ?? null,
            enc.ciphertext,
            enc.iv,
            enc.authTag,
            enc.keyVersion,
            user.id,
          ],
        );
        return metaById(res.rows[0].id, tx);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/credentials/:id/reveal',
    summary: 'Decrypt and return one secret (permission credential.reveal; never cached)',
    tag,
    access: { can: 'credential.reveal', target: credRobot },
    handler: async ({ params, reply, user, req }): Promise<CredentialRevealDto> => {
      const r = (
        await db.query<
          Omit<CredentialRevealDto, 'secret'> & { robot_id: string; slot: number | null; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; revoked_at: Date | null }
        >(
          'SELECT id, robot_id, kind, slot, username, host, port, auth_method, proxy, ciphertext, iv, auth_tag, key_version, revoked_at FROM robot_credentials WHERE id = $1',
          [params.id],
        )
      ).rows[0];
      if (!r) throw notFound('credential');
      if (r.revoked_at) throw conflict('credential is revoked');
      const secret = cipher.decrypt(
        { ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag, keyVersion: r.key_version },
        { robotId: r.robot_id, kind: r.kind, slot: r.slot },
      );
      // Device credentials are separate from user logins; every reveal is audited (never the secret itself).
      await app.audit.record({ action: 'credential.revealed', actor: user, target: { type: 'credential', id: r.id }, robotId: r.robot_id, detail: { kind: r.kind, slot: r.slot }, req });
      reply.header('Cache-Control', 'no-store, max-age=0').header('Pragma', 'no-cache');
      return { id: r.id, kind: r.kind, username: r.username, host: r.host, port: r.port, auth_method: r.auth_method, proxy: r.proxy, secret };
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/credentials/:id/rotate',
    summary: 'Rotate: revoke the current secret and store the replacement (history kept)',
    tag,
    access: { can: 'credential.write', target: credRobot },
    body: rotateBody,
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        const old = (
          await tx.query<{
            robot_id: string;
            kind: string;
            slot: number | null;
            label: string | null;
            username: string | null;
            host: string | null;
            port: number | null;
            auth_method: string | null;
            proxy: string | null;
            revoked_at: Date | null;
          }>(
            'SELECT robot_id, kind, slot, label, username, host, port, auth_method, proxy, revoked_at FROM robot_credentials WHERE id = $1 FOR UPDATE',
            [params.id],
          )
        ).rows[0];
        if (!old) throw notFound('credential');
        if (old.revoked_at) throw conflict('credential is already revoked; add a new one instead');
        await tx.query(`UPDATE robot_credentials SET revoked_at = now(), revoked_by = $2, revoke_reason = 'rotated' WHERE id = $1`, [params.id, user.id]);
        const enc = cipher.encrypt(body.secret, { robotId: old.robot_id, kind: old.kind, slot: old.slot });
        const res = await tx.query<{ id: string }>(
          `INSERT INTO robot_credentials (robot_id, kind, slot, label, username, host, port, auth_method, proxy, ciphertext, iv, auth_tag, key_version, rotated_from_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
          [
            old.robot_id,
            old.kind,
            old.slot,
            body.label !== undefined ? body.label : old.label,
            body.username !== undefined ? body.username : old.username,
            // SSH connection details carry over unless the rotation changes them.
            old.kind === 'ssh' && body.host !== undefined ? body.host : old.host,
            old.kind === 'ssh' && body.port !== undefined ? body.port : old.port,
            old.kind === 'ssh' && body.auth_method !== undefined ? body.auth_method : old.auth_method,
            old.kind === 'ssh' && body.proxy !== undefined ? body.proxy : old.proxy,
            enc.ciphertext,
            enc.iv,
            enc.authTag,
            enc.keyVersion,
            params.id,
            user.id,
          ],
        );
        return metaById(res.rows[0].id, tx);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/credentials/:id/revoke',
    summary: 'Revoke a lost/compromised credential (row kept, secret no longer revealable)',
    tag,
    access: { can: 'credential.write', target: credRobot },
    body: revokeBody,
    handler: async ({ params, body, user }) => {
      const res = await db.query('UPDATE robot_credentials SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL', [
        params.id,
        user.id,
        body.reason,
      ]);
      if (!res.rowCount) {
        await metaById(params.id, db);
        throw conflict('credential is already revoked');
      }
      return metaById(params.id, db);
    },
  });
}
