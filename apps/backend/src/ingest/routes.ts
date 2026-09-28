/**
 * Robot / GCS ingestion routes, served by the same backend as the admin API. They are NOT admin
 * routes: callers authenticate with an ingest key (`Authorization: Bearer …`), not a session, so they
 * sit outside route() and outside the admin CSRF hook, with their own body limit, rate limit and errors.
 */
import { withTransaction, type Db } from '@arnobot/db';
import { gcsMissionReportSchema, INGEST_MAX_BATCH } from '@arnobot/message-schema';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import type { ApiConfig } from '../lib/config';
import { IngestAuth, type IngestClient } from './auth';
import { MissionConflictError, mergeGcsReport } from './handlers/mission';
import type { IngestPipeline } from './pipeline';

declare module 'fastify' {
  interface FastifyRequest {
    ingestClient?: IngestClient;
  }
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown) {
  return reply.code(status).send({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

export function ingestRoutes(
  app: FastifyInstance,
  db: Db,
  pipeline: IngestPipeline,
  cfg: Pick<ApiConfig['ingest'], 'bodyLimitBytes' | 'rateLimitPerMinute'>,
): void {
  const auth = new IngestAuth(db);

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) app.log.error({ err }, 'unhandled error');
    const code = status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : status === 400 ? 'bad_request' : 'internal_error';
    return sendError(reply, status, code, status >= 500 ? 'internal error' : err.message);
  });

  const requireClient = async (req: FastifyRequest, reply: FastifyReply) => {
    const client = await auth.authenticate(req.headers.authorization);
    if (!client) return sendError(reply, 401, 'unauthorized', 'missing, invalid or revoked ingest key');
    req.ingestClient = client;
  };

  const opts: RouteShorthandOptions = {
    bodyLimit: cfg.bodyLimitBytes,
    // Per credential, not per IP: many robots may share one site NAT.
    config: {
      rateLimit: {
        max: cfg.rateLimitPerMinute,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => (req.headers.authorization ? `k:${req.headers.authorization.slice(-16)}` : `ip:${req.ip}`),
      },
    },
    preHandler: requireClient,
  };

  /**
   * POST /api/v1/ingest — one envelope or an array (backlog, oldest first).
   * Always 200 once authenticated; each message gets its own result. The sender deletes its local
   * copy on `stored` or `duplicate`, retries on `retryable: true`, and drops+logs other rejections.
   */
  app.post('/ingest', opts, async (req, reply) => {
    const body = req.body;
    const list = Array.isArray(body) ? body : [body];
    if (!list.length) return sendError(reply, 400, 'empty_batch', 'no messages in request');
    if (list.length > INGEST_MAX_BATCH) return sendError(reply, 413, 'batch_too_large', `max ${INGEST_MAX_BATCH} messages per request`);
    const results = await pipeline.processBatch(list, req.ingestClient!, 'https');
    const summary = { stored: 0, duplicate: 0, rejected: 0 };
    for (const r of results) summary[r.status]++;
    return { results, summary };
  });

  /** POST /api/v1/gcs/missions/:missionId/report — the GCS's completed mission report (spec §5). */
  app.post<{ Params: { missionId: string } }>('/gcs/missions/:missionId/report', opts, async (req, reply) => {
    const missionId = req.params.missionId;
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(missionId)) return sendError(reply, 400, 'bad_mission_id', 'invalid mission id');
    const parsed = gcsMissionReportSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_report', 'report failed validation', z.treeifyError(parsed.error));
    const report = parsed.data;
    const client = req.ingestClient!;
    if (!client.robotIds.has(report.robot_id)) {
      return sendError(reply, 403, 'robot_not_allowed', `this key may not report for ${report.robot_id}`);
    }
    const robot = (
      await db.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM robots WHERE robot_id = $1', [report.robot_id])
    ).rows[0];
    if (!robot || robot.deleted_at) return sendError(reply, 404, 'unknown_robot', `robot ${report.robot_id} is not registered`);
    try {
      const outcome = await withTransaction(db, async (tx) => {
        await tx.query('UPDATE live_state SET last_seen_at = now() WHERE robot_id = $1', [report.robot_id]);
        return mergeGcsReport(tx, missionId, report, req.body);
      });
      return reply.code(outcome === 'created' ? 201 : 200).send({ mission_id: missionId, status: outcome });
    } catch (err) {
      if (err instanceof MissionConflictError) return sendError(reply, 409, err.code, err.message);
      throw err;
    }
  });

}
