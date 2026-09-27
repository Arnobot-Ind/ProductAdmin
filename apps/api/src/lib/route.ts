/**
 * Route definition helper. Rule 13: permissions stay OUT of handler code — every route declares its
 * access up front, and this helper runs, in order:
 *   1. session authentication (unless `public`),
 *   2. Zod validation of query and body (multipart is streamed to a temp file) — signed-in users only,
 *   3. can(user, action, target) for the declared permission; the target may depend on the body,
 * and only then calls the handler. Undeclared access is impossible: `access` is required.
 * The same registry feeds the generated OpenAPI document.
 */
import type { Queryable } from '@arnobot/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppContext } from '../context';
import { SESSION_COOKIE, type AuthUser } from '../services/auth.service';
import type { Target } from '../services/permissions.service';
import { forbidden, notFound, unauthenticated } from './errors';
import { readMultipart, type UploadedFile } from './multipart';
import { assertRobotId, assertUuid, parseWith } from './validation';

export type TargetResolver = ((req: FastifyRequest, db: Queryable, body: unknown) => Target | Promise<Target>) & { describe: string };

export type Access = 'public' | 'signed_in' | { can: string; target: TargetResolver };

export interface HandlerCtx<B, Q> {
  req: FastifyRequest;
  reply: FastifyReply;
  user: AuthUser;
  params: Record<string, string>;
  body: B;
  query: Q;
  /** Present when `upload: true` and a file was sent. */
  file: UploadedFile | null;
  app: AppContext;
}

export interface RouteDef<B = unknown, Q = unknown> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  tag: string;
  access: Access;
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  /** multipart/form-data with one `file` field; text fields are validated with `body`. */
  upload?: boolean;
  /** Default 200 (204 when the handler returns undefined). */
  status?: number;
  handler: (ctx: HandlerCtx<B, Q>) => Promise<unknown> | unknown;
}

export const registry: RouteDef<unknown, unknown>[] = [];

// ── target resolvers ────────────────────────────────────────────────────────
const described = (fn: (req: FastifyRequest, db: Queryable, body: unknown) => Target | Promise<Target>, describe: string): TargetResolver =>
  Object.assign(fn, { describe });

const param = (req: FastifyRequest, name: string) => String((req.params as Record<string, string>)[name]);

export const platform = () => described(() => ({ type: 'platform' }), 'platform');

/** Holds the permission in any scope; the handler filters results with robotScope(). */
export const anyScope = () => described(() => ({ type: 'any' }), 'any scope (results filtered)');

/** Robot named by a route param (default `:robotId`). */
export const robotParam = (name = 'robotId') => described((req) => ({ type: 'robot', id: assertRobotId(param(req, name)) }), `robot :${name}`);

/**
 * Robot that owns another record, looked up by a route param. `sql` selects one `robot_id`
 * column with $1 = the param; a NULL robot_id means a platform-level record.
 */
export const robotVia = (sql: string, what: string, name = 'id', isUuid = true) =>
  described(async (req, db) => {
    const value = param(req, name);
    if (isUuid) assertUuid(value, name);
    const row = (await db.query<{ robot_id: string | null }>(sql, [value])).rows[0];
    if (!row) throw notFound(what);
    return row.robot_id ? { type: 'robot', id: row.robot_id } : { type: 'platform' };
  }, `robot of ${what} :${name}`);

/** Robot named by a body field when present, otherwise platform level (e.g. product documents). */
export const robotFromBody = (field = 'robot_id') =>
  described((_req, _db, body) => {
    const v = (body as Record<string, unknown> | undefined)?.[field];
    return typeof v === 'string' && v ? { type: 'robot', id: assertRobotId(v) } : { type: 'platform' };
  }, `robot in body.${field}, else platform`);

// ── registration ────────────────────────────────────────────────────────────
export function route<B = unknown, Q = unknown>(fastify: FastifyInstance, app: AppContext, def: RouteDef<B, Q>): void {
  registry.push(def as RouteDef<unknown, unknown>);
  fastify.route({
    method: def.method,
    url: def.path,
    handler: async (req, reply) => {
      let user: AuthUser | null = null;
      if (def.access !== 'public') {
        user = await app.auth.userFromToken(req.cookies[SESSION_COOKIE]);
        if (!user) throw unauthenticated();
      }

      const query = def.query ? parseWith(def.query, req.query ?? {}, 'query parameters') : (undefined as Q);
      let file: UploadedFile | null = null;
      let rawBody: unknown = req.body;
      if (def.upload) {
        const mp = await readMultipart(req, app.cfg.maxUploadBytes);
        file = mp.file;
        rawBody = mp.fields;
      }

      try {
        const body = def.body ? parseWith(def.body, rawBody ?? {}, 'request body') : (undefined as B);
        if (user && typeof def.access === 'object') {
          const target = await def.access.target(req, app.db, body);
          if (!(await app.perms.can(user, def.access.can, target))) throw forbidden(`requires ${def.access.can}`);
        }
        const result = await def.handler({
          req,
          reply,
          user: user as AuthUser,
          params: (req.params ?? {}) as Record<string, string>,
          body,
          query,
          file,
          app,
        });
        if (reply.sent) return reply;
        if (result === undefined) return reply.code(def.status ?? 204).send();
        return reply.code(def.status ?? 200).send(result);
      } finally {
        await file?.cleanup();
      }
    },
  });
}
