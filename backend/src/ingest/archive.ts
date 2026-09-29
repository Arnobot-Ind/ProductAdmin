/**
 * Robot → archive routes (cloud_sync on the robot). Authenticated with the robot's PMS ingest key
 * (`Authorization: Bearer <key>`, issued at registration); a key may only upload for its own robot(s),
 * and only robots registered in the PMS are accepted.
 *
 *   PUT  {base}/upload      one file; the backend streams it into the archive store and indexes it
 *        X-Object-Key: saibya02/sessions/<id>/video/cam1/20260925_101500.ts
 *        X-Content-SHA256: <hex sha256 of the body>
 *        → 200 { key, size, duplicate? }  stored (the robot may delete its copy)
 *          400 bad key / hash or size mismatch · 401 bad key · 403 other robot · 404 robot not registered
 *          409 would change stored data · 413 too big · 5xx retry later
 *   POST {base}/events      objects the robot put in the bucket itself: { events: [{ key, size, uploaded_at, manifest? }] }
 *   POST {base}/heartbeat   cloud_sync status (current session, backlog, disk, alerts), about once a minute
 *
 * Registered twice: under /api/v1/archive, and under /api/ingest with the Saibya Archive server's paths
 * (PUT /api/ingest/upload, POST /api/ingest, POST /api/ingest/heartbeat) so cloud_sync only needs the new
 * host and key. Idempotent: the same key + sha256 returns 200 again without storing twice. A stored file
 * never changes, and nothing in a complete session can change (except session.json, rewritten at stop).
 */
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { classify, COMPLETE_FILE, contentTypeFor, META_FILES, parseSessionKey, SESSION_FILE } from '../services/archive/keys';
import { IngestAuth, type IngestClient } from './auth';

const MAX_EVENTS = 500;
const MAX_STATUS_BYTES = 64_000;

function sendError(reply: FastifyReply, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error: { code, message, ...extra } });
}

export interface ArchivePaths {
  upload: string;
  events: string;
  heartbeat: string;
}

export function archiveIngestRoutes(app: FastifyInstance, ctx: AppContext, paths: ArchivePaths): void {
  const auth = new IngestAuth(ctx.db);
  const archive = ctx.archive;
  const maxBytes = archive.cfg.uploadMaxBytes;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) app.log.error({ err }, 'archive ingest error');
    return sendError(reply, status, status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'bad_request', status >= 500 ? 'internal error, retry later' : err.message);
  });

  const client = async (req: FastifyRequest, reply: FastifyReply): Promise<IngestClient | null> => {
    const c = await auth.authenticate(req.headers.authorization);
    if (!c) sendError(reply, 401, 'unauthorized', 'missing, invalid or revoked ingest key');
    return c;
  };

  const rateLimit = {
    rateLimit: {
      max: 1200,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => (req.headers.authorization ? `k:${req.headers.authorization.slice(-16)}` : `ip:${req.ip}`),
    },
  };

  // ── upload: raw body, streamed (never buffered), so any content type is passed through untouched ──
  void app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    raw.put(paths.upload, { config: rateLimit }, async (req, reply) => {
      const drain = () => req.raw.resume();
      const c = await client(req, reply);
      if (!c) return drain(), reply;

      const key = String(req.headers['x-object-key'] ?? '');
      const parsed = parseSessionKey(key);
      const file = parsed ? classify(parsed.name, archive.cfg.robotUtcOffsetMin) : null;
      if (!parsed || !file) return drain(), sendError(reply, 400, 'bad_key', 'Bad X-Object-Key: expected <robot_id>/[sim/]sessions/<session>/<path>');
      if (file.kind === 'meta' && !META_FILES.has(parsed.name)) {
        return drain(), sendError(reply, 400, 'bad_key', `Not a session file: ${parsed.name} (expected video, LiDAR, IMU or ${[...META_FILES].join(', ')})`);
      }
      if (!c.robotIds.has(parsed.robotId)) return drain(), sendError(reply, 403, 'robot_not_allowed', `this key may not upload for ${parsed.robotId}`, { key });
      if (!(await archive.registered([parsed.robotId])).has(parsed.robotId)) {
        return drain(), sendError(reply, 404, 'unknown_robot', `robot ${parsed.robotId} is not registered in the PMS (or is deleted)`);
      }

      const want = String(req.headers['x-content-sha256'] ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(want)) return drain(), sendError(reply, 400, 'bad_hash', 'X-Content-SHA256 must be 64 hex characters');
      const lengthHeader = req.headers['content-length'];
      const length = lengthHeader === undefined ? null : Number(lengthHeader);
      if (length !== null && (!Number.isSafeInteger(length) || length < 0)) return drain(), sendError(reply, 400, 'bad_length', 'Bad Content-Length');
      if (length !== null && length > maxBytes) return drain(), sendError(reply, 413, 'payload_too_large', `File is larger than ${maxBytes / 1024 / 1024} MB`);

      const prev = await archive.storedFile(key);
      if (prev && prev.sha256 === want && (length === null || prev.size === length)) {
        drain();
        return { key, size: prev.size, duplicate: true };
      }
      if (await archive.sessionComplete(parsed.robotId, parsed.sim, parsed.sessionId)) {
        return drain(), sendError(reply, 409, 'session_complete', 'Session is complete: its files can no longer change', { key });
      }
      if (prev?.sha256 && parsed.name !== SESSION_FILE) {
        return drain(), sendError(reply, 409, 'immutable', 'Already stored with different content: stored files never change', { key });
      }

      // Count, hash and cap the bytes on their way to the store. session.json is also kept (a few KB): it is the manifest.
      const hash = createHash('sha256');
      const keepBody = parsed.name === SESSION_FILE;
      const kept: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          if (size > maxBytes) {
            tooLarge = true;
            return done(new Error('upload too large'));
          }
          hash.update(chunk);
          if (keepBody) kept.push(chunk);
          done(null, chunk);
        },
      });
      const source = (req.body as Readable | undefined) ?? req.raw;
      source.on('error', (e) => meter.destroy(e));
      source.pipe(meter);

      try {
        await archive.storage.put(key, meter, contentTypeFor(key));
      } catch (err) {
        if (tooLarge) return sendError(reply, 413, 'payload_too_large', `File is larger than ${maxBytes / 1024 / 1024} MB`);
        req.log.error({ err, key }, 'archive upload failed');
        return sendError(reply, 502, 'storage_error', 'Could not store the file, retry later');
      }

      const got = hash.digest('hex');
      if (got !== want || (length !== null && size !== length)) {
        await archive.forgetSha256(key);
        return sendError(reply, 400, 'hash_mismatch', 'Body does not match X-Content-SHA256 / Content-Length', { size, sha256: got });
      }
      let manifest: Record<string, unknown> | null | undefined;
      if (keepBody) {
        try {
          manifest = JSON.parse(Buffer.concat(kept).toString('utf8')) as Record<string, unknown>;
        } catch {
          manifest = null;
        }
      }
      await archive.record(
        [{ key, robotId: parsed.robotId, sim: parsed.sim, sessionId: parsed.sessionId, file, size, sha256: got, manifest, uploadedAt: new Date() }],
        true,
      );
      if (file.name === COMPLETE_FILE) req.log.info({ key }, 'archive session complete');
      return { key, size };
    });
  });

  // ── JSON routes ──
  app.post(paths.events, { config: rateLimit }, async (req, reply) => {
    const c = await client(req, reply);
    if (!c) return reply;
    const body = req.body as { events?: unknown } | undefined;
    const events = Array.isArray(body?.events) ? body.events : [];
    if (!events.length || events.length > MAX_EVENTS) return sendError(reply, 400, 'bad_batch', `Send 1-${MAX_EVENTS} events: { events: [...] }`);
    return archive.recordReported(events, (robotId) => c.robotIds.has(robotId));
  });

  app.post(paths.heartbeat, { config: rateLimit }, async (req, reply) => {
    const c = await client(req, reply);
    if (!c) return reply;
    const status = (req.body ?? {}) as Record<string, unknown>;
    if (JSON.stringify(status).length > MAX_STATUS_BYTES) return sendError(reply, 413, 'payload_too_large', 'Status too large');
    // A robot key speaks for one robot; a GCS relaying several must name it.
    const named = typeof status.robot_id === 'string' ? status.robot_id : null;
    const robotId = named ?? (c.robotIds.size === 1 ? [...c.robotIds][0] : null);
    if (!robotId) return sendError(reply, 400, 'robot_required', 'This key speaks for several robots: put "robot_id" in the body');
    if (!c.robotIds.has(robotId)) return sendError(reply, 403, 'robot_not_allowed', `this key may not report for ${robotId}`);
    if (!(await archive.registered([robotId])).has(robotId)) return sendError(reply, 404, 'unknown_robot', `robot ${robotId} is not registered in the PMS`);
    await archive.heartbeat(robotId, status);
    return { ok: true, robot: robotId };
  });
}
