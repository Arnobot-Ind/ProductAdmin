import { addIngestKey, createIngestClient, withTransaction, type Queryable } from '@arnobot/db';
import type { IngestClientDto, IngestKeyIssuedDto, IngestLogItemDto, IngestRejectionDto, Paginated } from '@arnobot/message-schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { anyScope, platform, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { assertUuid, nullableText, pageQuery, robotIdSchema, uuidSchema } from '../lib/validation';

const CLIENT_SELECT = `
SELECT c.id, c.name, c.kind, c.notes, c.created_at, c.revoked_at,
       coalesce((SELECT array_agg(r.robot_id ORDER BY r.robot_id) FROM ingest_client_robots r
                 WHERE r.client_id = c.id AND r.revoked_at IS NULL), '{}') AS robot_ids,
       coalesce((SELECT json_agg(json_build_object('id', k.id, 'key_prefix', k.key_prefix, 'created_at', k.created_at,
                                                  'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at) ORDER BY k.created_at DESC)
                 FROM ingest_keys k WHERE k.client_id = c.id), '[]') AS keys
FROM ingest_clients c`;
const toClient = (r: Record<string, unknown>): IngestClientDto => ({
  ...(r as unknown as IngestClientDto),
  created_at: iso(r.created_at as Date)!,
  revoked_at: iso(r.revoked_at as Date | null),
  keys: (r.keys as IngestClientDto['keys']).map((k) => ({ ...k, created_at: iso(k.created_at)!, last_used_at: iso(k.last_used_at), revoked_at: iso(k.revoked_at) })),
});

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.literal('gcs'),
  robot_ids: z.array(robotIdSchema).min(1).max(500),
  notes: nullableText(1000).optional(),
});

/**
 * Who may push data into the PMS (POST /api/v1/ingest). A robot client is created with each robot; GCS clients
 * are created here and assigned the robots they relay for. Keys are shown once and stored as SHA-256.
 * Rotation = issue a new key, deploy it, then revoke the old one (zero downtime).
 */
export function ingestAdminRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Ingest';
  const manage = { can: 'ingest.manage', target: platform() };

  const clientById = async (id: string, q: Queryable) => {
    const r = (await q.query(`${CLIENT_SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!r) throw notFound('ingest client');
    return toClient(r);
  };
  const assertRobots = async (ids: string[], q: Queryable) => {
    const found = await q.query<{ robot_id: string }>('SELECT robot_id FROM robots WHERE robot_id = ANY($1) AND deleted_at IS NULL', [ids]);
    const missing = ids.filter((id) => !found.rows.some((r) => r.robot_id === id));
    if (missing.length) throw badRequest(`unknown robot(s): ${missing.join(', ')}`);
  };

  route(f, app, {
    method: 'GET',
    path: '/ingest-clients',
    summary: 'Robot and GCS ingest clients with their keys (prefix only)',
    tag,
    access: manage,
    query: z.object({ robot_id: robotIdSchema.optional() }),
    handler: async ({ query }): Promise<IngestClientDto[]> => {
      const w = new Where();
      if (query.robot_id) w.add('EXISTS (SELECT 1 FROM ingest_client_robots r WHERE r.client_id = c.id AND r.robot_id = ?)', query.robot_id);
      const rows = await db.query(`${CLIENT_SELECT} ${w.toSql()} ORDER BY c.revoked_at IS NOT NULL, c.kind, c.name`, w.params);
      return rows.rows.map(toClient);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/ingest-clients',
    summary: 'Create a GCS ingest client for a set of robots; returns its key ONCE',
    tag,
    access: manage,
    body: createBody,
    status: 201,
    handler: ({ body, user }): Promise<IngestKeyIssuedDto> =>
      withTransaction(db, async (tx) => {
        const robotIds = [...new Set(body.robot_ids)];
        await assertRobots(robotIds, tx);
        const created = await createIngestClient(tx, { name: body.name, kind: 'gcs', robotIds, notes: body.notes ?? null, createdBy: user.id });
        const client = await clientById(created.clientId, tx);
        return { client, key_id: client.keys[0].id, key: created.key };
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/ingest-clients/:id/keys',
    summary: 'Issue an additional key (rotation); the old key stays valid until revoked',
    tag,
    access: manage,
    status: 201,
    handler: ({ params, user }): Promise<IngestKeyIssuedDto> =>
      withTransaction(db, async (tx) => {
        assertUuid(params.id);
        const c = await clientById(params.id, tx);
        if (c.revoked_at) throw conflict('client is revoked');
        const k = await addIngestKey(tx, params.id, user.id);
        return { client: await clientById(params.id, tx), key_id: k.id, key: k.key };
      }),
  });

  route(f, app, {
    method: 'PUT',
    path: '/ingest-clients/:id/robots',
    summary: 'Set which robots a GCS client may report for',
    tag,
    access: manage,
    body: z.object({ robot_ids: z.array(robotIdSchema).max(500) }),
    handler: ({ params, body, user }) =>
      withTransaction(db, async (tx) => {
        assertUuid(params.id);
        const c = await clientById(params.id, tx);
        if (c.kind !== 'gcs') throw badRequest('a robot client always speaks for exactly its own robot');
        const next = [...new Set(body.robot_ids)];
        await assertRobots(next, tx);
        await tx.query('UPDATE ingest_client_robots SET revoked_at = now() WHERE client_id = $1 AND revoked_at IS NULL AND NOT (robot_id = ANY($2))', [params.id, next]);
        for (const r of next) {
          await tx.query(
            `INSERT INTO ingest_client_robots (client_id, robot_id, created_by) VALUES ($1, $2, $3)
             ON CONFLICT (client_id, robot_id) DO UPDATE SET revoked_at = NULL`,
            [params.id, r, user.id],
          );
        }
        return clientById(params.id, tx);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/ingest-clients/:id/revoke',
    summary: 'Revoke a client and all its keys (stops ingestion from it within ~10 s)',
    tag,
    access: manage,
    handler: ({ params, user }) =>
      withTransaction(db, async (tx) => {
        assertUuid(params.id);
        const res = await tx.query('UPDATE ingest_clients SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [params.id, user.id]);
        if (!res.rowCount) throw conflict('client not found or already revoked');
        await tx.query('UPDATE ingest_keys SET revoked_at = now(), revoked_by = $2 WHERE client_id = $1 AND revoked_at IS NULL', [params.id, user.id]);
        return clientById(params.id, tx);
      }),
  });

  route(f, app, {
    method: 'POST',
    path: '/ingest-keys/:id/revoke',
    summary: 'Revoke one key (e.g. lost or leaked)',
    tag,
    access: manage,
    handler: async ({ params, user }) => {
      assertUuid(params.id);
      const r = (await db.query<{ client_id: string }>('UPDATE ingest_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING client_id', [params.id, user.id])).rows[0];
      if (!r) throw conflict('key not found or already revoked');
      return clientById(r.client_id, db);
    },
  });

  // ── ingest log ───────────────────────────────────────────────────────────
  route(f, app, {
    method: 'GET',
    path: '/ingest/messages',
    summary: 'Accepted robot messages (newest first)',
    tag,
    access: { can: 'ingest.read', target: anyScope() },
    query: z.object({ robot: robotIdSchema.optional(), type: z.string().max(20).optional(), ...pageQuery }),
    handler: ({ query, user }): Promise<Paginated<IngestLogItemDto>> => {
      const w = new Where();
      app.perms.applyRobotScope(w, app.perms.robotScope(user, 'ingest.read'), 'm.robot_id');
      if (query.robot) w.add('m.robot_id = ?', query.robot);
      if (query.type) w.add('m.type = ?', query.type);
      return paginate(
        db,
        `SELECT m.msg_id, m.robot_id, m.type, m.v, m.ts, m.received_at, m.transport, c.name AS client_name
         FROM ingested_messages m LEFT JOIN ingest_clients c ON c.id = m.client_id`,
        w,
        'm.received_at DESC',
        query.page,
        query.limit,
        (r: Record<string, unknown>) => ({ ...r, ts: iso(r.ts as Date), received_at: iso(r.received_at as Date) }),
      ) as Promise<Paginated<IngestLogItemDto>>;
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/ingest/messages/:msgId',
    summary: 'One accepted message including the raw envelope as received',
    tag,
    access: { can: 'ingest.read', target: anyScope() },
    handler: async ({ params, user }): Promise<IngestLogItemDto> => {
      if (!uuidSchema.safeParse(params.msgId).success) throw badRequest('msg_id must be a UUID');
      const r = (
        await db.query(
          `SELECT m.msg_id, m.robot_id, m.type, m.v, m.ts, m.received_at, m.transport, c.name AS client_name, m.raw
           FROM ingested_messages m LEFT JOIN ingest_clients c ON c.id = m.client_id WHERE m.msg_id = $1`,
          [params.msgId],
        )
      ).rows[0];
      if (!r || !(await app.perms.can(user, 'ingest.read', { type: 'robot', id: r.robot_id }))) throw notFound('message');
      return { ...r, ts: iso(r.ts)!, received_at: iso(r.received_at)! };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/ingest/rejections',
    summary: 'Rejected messages with the reason (kept for diagnosis)',
    tag,
    access: { can: 'ingest.read', target: platform() },
    query: z.object({ ...pageQuery }),
    handler: ({ query }): Promise<Paginated<IngestRejectionDto>> =>
      paginate(
        db,
        `SELECT r.id, r.received_at, r.msg_id, r.robot_id, r.type, r.error, r.details, c.name AS client_name, r.raw
         FROM ingest_rejections r LEFT JOIN ingest_clients c ON c.id = r.client_id`,
        new Where(),
        'r.received_at DESC, r.id DESC',
        query.page,
        query.limit,
        (r: Record<string, unknown>) => ({ ...r, received_at: iso(r.received_at as Date) }),
      ) as Promise<Paginated<IngestRejectionDto>>,
  });
}
