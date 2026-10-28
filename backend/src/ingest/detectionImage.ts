/**
 * Robot → detection snapshot (fleetSync), the image half of a `detection` message (0024). Ingest-key auth, like
 * POST /ingest. Same contract as the robot software expects:
 *
 *   PUT {API_PREFIX}/ingest/detections/:detectionId/image
 *       X-Robot-Id: saibya02            (optional when the key speaks for one robot only)
 *       X-Content-SHA256: <hex sha256 of the body>
 *       body: the JPEG (≤ DETECTION_IMAGE_MAX_BYTES)
 *   → 200 { key, size, duplicate? }   stored, or a snapshot is already there (the robot may delete its copy)
 *     400 bad request / hash mismatch · 401 bad key · 403 other robot
 *     404 detection_not_found — the `detection` message has not been stored yet: send it, then retry
 *     409 immutable — this detection already has a different uploaded image · 413 too big · 5xx retry later
 *
 * Stored in the archive bucket at <robot_id>/detections/<YYYY-MM-DD UTC>/<detection_id>.jpg; the bucket stays private
 * and both apps stream it through /robots/:robotId/[client/]detections/:id/image.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context';
import { DETECTION_IMAGE_MAX_BYTES } from '../shared';
import { IngestAuth } from './auth';

const ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export function detectionImageKey(robotId: string, detectedAt: Date, detectionId: string): string {
  return `${robotId}/detections/${detectedAt.toISOString().slice(0, 10)}/${detectionId}.jpg`;
}

export function detectionImageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = new IngestAuth(ctx.db);

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: DETECTION_IMAGE_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.put<{ Params: { detectionId: string } }>(
    '/ingest/detections/:detectionId/image',
    {
      bodyLimit: DETECTION_IMAGE_MAX_BYTES,
      config: {
        rateLimit: {
          max: 600,
          timeWindow: '1 minute',
          keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) =>
            typeof req.headers.authorization === 'string' ? `k:${req.headers.authorization.slice(-16)}` : `ip:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const client = await auth.authenticate(req.headers.authorization);
      if (!client) return sendError(reply, 401, 'unauthorized', 'missing, invalid or revoked ingest key');

      const detectionId = req.params.detectionId;
      if (!ID_RE.test(detectionId)) return sendError(reply, 400, 'bad_detection_id', 'detection id must be 1-100 of A-Z a-z 0-9 . _ -');
      const header = String(req.headers['x-robot-id'] ?? '').trim();
      const robotId = header || (client.robotIds.size === 1 ? [...client.robotIds][0] : '');
      if (!robotId) return sendError(reply, 400, 'robot_required', 'X-Robot-Id is required: this key speaks for several robots');
      if (!client.robotIds.has(robotId)) return sendError(reply, 403, 'robot_not_allowed', `this key may not upload for ${robotId}`);

      const want = String(req.headers['x-content-sha256'] ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(want)) return sendError(reply, 400, 'bad_hash', 'X-Content-SHA256 must be 64 hex characters');
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return sendError(reply, 400, 'empty_body', 'the request body must be the image');
      const got = createHash('sha256').update(body).digest('hex');
      if (got !== want) return sendError(reply, 400, 'hash_mismatch', 'body does not match X-Content-SHA256');

      const row = (
        await ctx.db.query<{ id: string; detected_at: Date; image_key: string | null; image_sha256: string | null; image_size_bytes: number | null }>(
          'SELECT id, detected_at, image_key, image_sha256, image_size_bytes FROM detections WHERE robot_id = $1 AND detection_id = $2',
          [robotId, detectionId],
        )
      ).rows[0];
      if (!row) return sendError(reply, 404, 'detection_not_found', `no detection ${detectionId} for ${robotId} yet: send the detection message first`);
      if (row.image_key) {
        // Imported snapshots (0022) have no hash: the robot's copy is the same picture, keep ours.
        if (!row.image_sha256 || row.image_sha256 === got) return { key: row.image_key, size: row.image_size_bytes ?? body.length, duplicate: true };
        return sendError(reply, 409, 'immutable', 'this detection already has a different image');
      }

      const key = detectionImageKey(robotId, row.detected_at, detectionId);
      const type = body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg' : 'application/octet-stream';
      try {
        await ctx.archive.storage.put(key, Readable.from(body), type);
      } catch (err) {
        req.log.error({ err, key }, 'detection image upload failed');
        return sendError(reply, 502, 'storage_error', 'could not store the image, retry later');
      }
      await ctx.db.query(
        `UPDATE detections SET image_key = $2, image_sha256 = $3, image_size_bytes = $4, image_uploaded_at = now() WHERE id = $1 AND image_key IS NULL`,
        [row.id, key, got, body.length],
      );
      return { key, size: body.length };
    },
  );
}
