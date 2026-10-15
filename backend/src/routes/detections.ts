/**
 * Camera detections (0022): what the robot's cameras detected — people, wildlife, fire / smoke, vegetation — with the
 * snapshot JPEG. Two route sets over the same index, like events and telemetry:
 *   admin panel  /robots/:robotId/detections…         robot.details; rejected (false positive) ones on request
 *   client app   /robots/:robotId/client/detections…  robot.read + portal.detections.view; confirmed people only
 *                                                     (CLIENT_KINDS), no internal fields, position only with
 *                                                     portal.robots.location
 * Every row and every image stays inside what the user may see of the robot's data (ownership periods, the data
 * history limit). Images stream from the archive bucket through the backend; the bucket stays private.
 */
import { CLIENT_FEATURES, DETECTION_KINDS, type DetectionBoxDto, type DetectionItemDto, type DetectionKind, type DetectionListDto } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { badRequest, notFound } from '../lib/errors';
import { robotParam, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { assertUuid, isoDateTime, pageQuery } from '../lib/validation';
import type { AuthUser } from '../services/auth.service';
import { ObjectNotFound } from '../services/archive/storage';

const listQuery = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  kind: z.enum(DETECTION_KINDS).optional(),
  camera: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(),
  ...pageQuery,
});
const staffQuery = listQuery.extend({ status: z.enum(['confirmed', 'rejected', 'all']).default('confirmed') });

const SELECT = `SELECT d.id, d.robot_id, d.detected_at, d.time_estimated, d.kind, d.label, d.labels, d.camera, d.count, d.confidence,
                       d.boxes, d.lat, d.lon, d.mission_id, d.mission_name, d.image_key IS NOT NULL AS has_image, d.status, d.source
                FROM detections d`;

type Audience = 'staff' | 'client';
/** What customers are shown (user decision, 2026-10-15): people only; wildlife, fire / smoke and vegetation stay staff-side. */
const CLIENT_KINDS: DetectionKind[] = ['human'];
const ACTION: Record<Audience, string> = { staff: 'robot.details', client: 'robot.read' };
const base = (audience: Audience, robotId: string) => `/api/v1/robots/${encodeURIComponent(robotId)}${audience === 'client' ? '/client' : ''}/detections`;

export function detectionRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, robots } = app;

  /** The rows of `robotId` the user may see: data scope (ownership periods, history limit) + status. */
  const scoped = (user: AuthUser, audience: Audience, robotId: string, status: 'confirmed' | 'rejected' | 'all'): Where => {
    const w = app.perms.applyDataScope(new Where(), app.perms.robotScope(user, ACTION[audience]), 'd.robot_id', 'd.detected_at');
    w.add('d.robot_id = ?', robotId);
    if (status !== 'all') w.add('d.status = ?', audience === 'client' ? 'confirmed' : status);
    if (audience === 'client') w.add('d.kind = ANY(?::text[])', CLIENT_KINDS);
    return w;
  };

  const list = async (user: AuthUser, audience: Audience, robotId: string, q: z.infer<typeof staffQuery>): Promise<DetectionListDto> => {
    await robots.assertExists(robotId, { allowDeleted: true });
    if (q.from && q.to && q.from >= q.to) throw badRequest('from must be before to');
    const status = audience === 'client' ? 'confirmed' : q.status;
    // Customers see a position only with the location feature, like the robot's own track.
    const location = audience === 'staff' || !user.client || user.client.features.has(CLIENT_FEATURES.robotsLocation);

    const period = scoped(user, audience, robotId, status);
    if (q.from) period.add('d.detected_at >= ?', q.from);
    if (q.to) period.add('d.detected_at < ?', q.to);
    const [counts, cameras, available] = await Promise.all([
      db.query<{ kind: DetectionKind; count: number }>(`SELECT d.kind, count(*)::int AS count FROM detections d ${period.toSql()} GROUP BY 1 ORDER BY 2 DESC`, period.params),
      db.query<{ camera: string }>(`SELECT DISTINCT d.camera FROM detections d ${period.toSql()} ORDER BY 1`, period.params),
      (() => {
        const all = scoped(user, audience, robotId, status);
        return db.query<{ first: Date | null; last: Date | null }>(`SELECT min(d.detected_at) AS first, max(d.detected_at) AS last FROM detections d ${all.toSql()}`, all.params);
      })(),
    ]);

    const w = scoped(user, audience, robotId, status);
    if (q.from) w.add('d.detected_at >= ?', q.from);
    if (q.to) w.add('d.detected_at < ?', q.to);
    if (q.kind) w.add('d.kind = ?', q.kind);
    if (q.camera) w.add('d.camera = ?', q.camera);
    const page = await paginate(db, SELECT, w, 'd.detected_at DESC, d.id', q.page, q.limit, (r: Record<string, unknown>): DetectionItemDto => {
      const item: DetectionItemDto = {
        id: r.id as string,
        robot_id: r.robot_id as string,
        detected_at: iso(r.detected_at as Date)!,
        time_estimated: r.time_estimated as boolean,
        kind: r.kind as DetectionKind,
        label: (r.label as string | null) ?? null,
        labels: (r.labels as Record<string, number> | null) ?? null,
        camera: r.camera as string,
        count: r.count as number,
        confidence: (r.confidence as number | null) ?? null,
        boxes: (r.boxes as DetectionBoxDto[] | null) ?? [],
        lat: location ? ((r.lat as number | null) ?? null) : null,
        lon: location ? ((r.lon as number | null) ?? null) : null,
        mission_id: (r.mission_id as string | null) ?? null,
        mission_name: (r.mission_name as string | null) ?? null,
        image_url: r.has_image ? `${base(audience, robotId)}/${r.id as string}/image` : null,
      };
      if (audience === 'staff') {
        item.status = r.status as DetectionItemDto['status'];
        item.source = r.source as string;
      }
      return item;
    });
    const a = available.rows[0];
    return {
      ...(page as unknown as DetectionListDto),
      counts: counts.rows,
      cameras: cameras.rows.map((c) => c.camera),
      available: a?.first && a.last ? { first: a.first.toISOString(), last: a.last.toISOString() } : null,
    };
  };

  const image = async (user: AuthUser, audience: Audience, robotId: string, id: string) => {
    assertUuid(id, 'id');
    const w = scoped(user, audience, robotId, audience === 'client' ? 'confirmed' : 'all').add('d.id = ?', id);
    const row = (await db.query<{ image_key: string | null }>(`SELECT d.image_key FROM detections d ${w.toSql()}`, w.params)).rows[0];
    if (!row?.image_key) throw notFound('detection image');
    try {
      return await app.archive.storage.get(row.image_key);
    } catch (err) {
      if (err instanceof ObjectNotFound) throw notFound('detection image');
      throw err;
    }
  };

  for (const audience of ['staff', 'client'] as const) {
    const path = audience === 'client' ? '/robots/:robotId/client/detections' : '/robots/:robotId/detections';
    const access = { can: ACTION[audience], target: robotParam() };
    const feature = audience === 'client' ? CLIENT_FEATURES.detectionsView : undefined;
    const tag = audience === 'client' ? 'Client app' : 'Detections';

    route(f, app, {
      method: 'GET',
      path,
      summary:
        audience === 'client'
          ? 'People the cameras of one robot detected, newest first, with counts'
          : 'Camera detections of one robot, newest first, with per-kind counts; status=rejected / all shows false positives too',
      tag,
      access,
      feature,
      query: audience === 'client' ? listQuery : staffQuery,
      handler: ({ params, query, user }) => {
        const q = query as z.infer<typeof listQuery> & { status?: z.infer<typeof staffQuery>['status'] };
        return list(user, audience, params.robotId, { ...q, status: q.status ?? 'confirmed' });
      },
    });

    route(f, app, {
      method: 'GET',
      path: `${path}/:id/image`,
      summary: 'The snapshot JPEG of one detection (streamed from the archive bucket)',
      tag,
      access,
      feature,
      handler: async ({ params, user, reply }) => {
        const obj = await image(user, audience, params.robotId, params.id);
        // A snapshot never changes once taken.
        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Content-Length', String(obj.length))
          .header('Cache-Control', 'private, max-age=86400, immutable')
          .header('X-Content-Type-Options', 'nosniff')
          .send(obj.body);
      },
    });
  }
}
