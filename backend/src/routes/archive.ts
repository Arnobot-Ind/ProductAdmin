/**
 * Video / sensor archive for the admin panel. Access, per recording:
 *   view      robot.read on the robot, AND the recording was not made while another customer organization
 *             owned the robot. Video plays (HLS); LiDAR / IMU show as previews.
 *   download  data.download: MP4 / .ts video, session.json, upload log.
 *   sensors   data.sensors: LiDAR / IMU are shown at all (previews); without it they are hidden (Admin only).
 *   restricted data.download_restricted: raw LiDAR (.npz) and IMU (.csv.gz) chunks, inline or not.
 *   delete    data.delete: hide / restore a recording (the objects stay in the bucket).
 * Files stream through the backend with Range support, so the bucket stays private and the browser never
 * sees a storage URL. Opening a recording and every download are written to the audit log.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ArchiveAccessDto, ArchiveSessionDto, ArchiveReindexDto, ArchiveSessionDetailDto, ArchiveSessionListDto, ImuPreviewDto, LidarPreviewDto, RobotArchiveDto } from '../shared';
import type { AppContext } from '../context';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { ZipWriter } from '../lib/zip';
import { anyScope, assertCan, platform, robotParam, robotVia, route } from '../lib/route';
import { nullableText, optionalBool, pageQuery, robotIdSchema } from '../lib/validation';
import type { AuthUser } from '../services/auth.service';
import { contentTypeFor, isCameraName } from '../services/archive/keys';
import { mp4Name } from '../services/archive/mp4';
import { ObjectNotFound, parseRange, RangeNotSatisfiable, type ObjectStream } from '../services/archive/storage';

const listQuery = z.object({
  robot: robotIdSchema.optional(),
  product: z.string().max(50).optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'closed', 'interrupted']).optional(),
  include_sim: optionalBool,
  /** Deleted recordings too (only for users who may restore them). */
  include_deleted: optionalBool,
  ...pageQuery,
});
/** Groups of a recording that can be zipped together; the sensor ones are restricted data. */
const ZIP_GROUPS = ['video', 'imu', 'gps', 'lidar', 'encoder', 'meta'] as const;
type ZipGroup = (typeof ZIP_GROUPS)[number];
const SENSOR_GROUPS = new Set<ZipGroup>(['imu', 'gps', 'lidar', 'encoder']);
const reindexBody = z.object({ robot_id: robotIdSchema.optional(), full: z.boolean().optional() }).strict();

const sessionRobot = robotVia('SELECT robot_id FROM archive_sessions WHERE id = $1', 'recording');
/** The moment a recording belongs to (ownership-period checks). */
const SESSION_TIME = 'coalesce(s.started_at, s.created_at)';

function disposition(kind: 'inline' | 'attachment', name: string): string {
  return `${kind}; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
}

function sendObject(reply: FastifyReply, obj: ObjectStream, contentType: string, downloadName?: string): FastifyReply {
  reply.header('Content-Type', contentType).header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, max-age=300').header('Content-Length', String(obj.length));
  if (obj.contentRange) reply.header('Content-Range', obj.contentRange);
  if (obj.etag) reply.header('ETag', obj.etag);
  if (obj.lastModified) reply.header('Last-Modified', obj.lastModified.toUTCString());
  if (downloadName) reply.header('Content-Disposition', disposition('attachment', downloadName));
  return reply.code(obj.contentRange ? 206 : 200).send(obj.body);
}

function storageError(err: unknown, reply: FastifyReply): never | FastifyReply {
  if (err instanceof ObjectNotFound) throw notFound('file in the archive store');
  if (err instanceof RangeNotSatisfiable) {
    if (err.size !== null) reply.header('Content-Range', `bytes */${err.size}`);
    throw new ApiError(416, 'range_not_satisfiable', 'range not satisfiable');
  }
  throw err;
}

/** A Range request that does not start at byte 0 continues a download already counted. */
const firstBytes = (req: FastifyRequest) => !req.headers.range || /^bytes=0-/.test(req.headers.range);

export function archiveRoutes(f: FastifyInstance, app: AppContext): void {
  const tag = 'Archive';
  const { archive, perms } = app;

  /**
   * Second gate after the declared robot.read on the recording's robot: the recording must not belong to
   * another customer's ownership period. Answers 404 (not 403): other organizations' data does not exist for them.
   */
  const visibleSession = async (user: AuthUser, id: string, allowDeleted = false): Promise<{ robotId: string; at: Date }> => {
    const owner = await archive.sessionOwner(id, allowDeleted);
    if (!owner || !(await perms.canSeeData(user, 'robot.read', owner.robotId, owner.at))) throw notFound('recording');
    return owner;
  };
  /** Recording lists for roles that do not see sensor data: no LiDAR / IMU / GPS / encoder details. */
  const maskSensors = <T extends ArchiveSessionDto>(user: AuthUser, s: T): T =>
    perms.holdsAnywhere(user, 'data.sensors')
      ? s
      : {
          ...s,
          has_lidar: false,
          has_imu: false,
          has_gps: false,
          has_encoder: false,
          sensor_bytes: { lidar: 0, imu: 0, gps: 0, encoder: 0 },
          bytes: { ...s.bytes, sensors: 0, total: s.bytes.total - s.bytes.sensors },
        };
  const accessFor = async (user: AuthUser, robotId: string): Promise<ArchiveAccessDto> => {
    const target = { type: 'robot' as const, id: robotId };
    const [sensors, download, restricted, del] = await Promise.all([
      perms.can(user, 'data.sensors', target),
      perms.can(user, 'data.download', target),
      perms.can(user, 'data.download_restricted', target),
      perms.can(user, 'data.delete', target),
    ]);
    return { sensors, download, download_restricted: restricted, delete: del };
  };

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions',
    summary: 'Recorded sessions (video + sensors) the user may see, newest first',
    tag,
    access: { can: 'robot.read', target: anyScope() },
    query: listQuery,
    handler: async ({ query: q, user }): Promise<ArchiveSessionListDto> => {
      const list = await archive.listSessions({ ...q, include_sim: q.include_sim ?? false, include_deleted: (q.include_deleted ?? false) && perms.holdsAnywhere(user, 'data.delete') }, (w) =>
        perms.applyDataScope(w, perms.robotScope(user, 'robot.read'), 's.robot_id', SESSION_TIME),
      );
      return { ...list, items: list.items.map((s) => maskSensors(user, s)) };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/archive',
    summary: 'One robot’s recorded sessions (those the user may see) and its upload link (heartbeat, backlog, alerts)',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    query: z.object({ include_deleted: optionalBool }),
    handler: async ({ params, query, user }): Promise<RobotArchiveDto> => {
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      const withDeleted = (query.include_deleted ?? false) && (await perms.can(user, 'data.delete', { type: 'robot', id: params.robotId }));
      const a = await archive.robotArchive(params.robotId, (w) => perms.applyDataScope(w, perms.robotScope(user, 'robot.read'), 's.robot_id', SESSION_TIME), withDeleted);
      return { ...a, sessions: a.sessions.map((s) => maskSensors(user, s)) };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions/:id',
    summary: 'One recording: summary, streams (video / LiDAR / IMU / metadata, missing ones included), cameras, files and what the user may do',
    tag,
    access: { can: 'robot.read', target: sessionRobot },
    handler: async ({ params, user, req }): Promise<ArchiveSessionDetailDto> => {
      const probe = await archive.sessionOwner(params.id, true);
      const access = probe ? await accessFor(user, probe.robotId) : { sensors: false, download: false, download_restricted: false, delete: false };
      // Deleted recordings stay visible (read-only, with Restore) to users who may restore them.
      const owner = await visibleSession(user, params.id, access.delete);
      const full = await archive.detail(params.id, access, access.delete);
      // Sensor data (LiDAR, IMU, GPS, encoders) is not shown to roles without data.sensors: same shape, streams marked not available.
      const hidden = (what: string) => ({ available: false, files: 0, bytes: 0, reason: `${what} data is not shown for your role.` });
      const detail: ArchiveSessionDetailDto = access.sensors
        ? full
        : {
            ...full,
            files: full.files.filter((f) => f.kind !== 'sensors'),
            session: {
              ...full.session,
              has_lidar: false,
              has_imu: false,
              has_gps: false,
              has_encoder: false,
              bytes: { ...full.session.bytes, sensors: 0, total: full.session.bytes.total - full.session.bytes.sensors },
            },
            streams: { ...full.streams, lidar: hidden('LiDAR'), imu: hidden('IMU'), gps: hidden('GPS'), encoder: hidden('Encoder') },
          };
      app.audit.note({ action: 'data.viewed', actor: user, target: { type: 'recording', id: params.id }, robotId: owner.robotId, detail: { session_id: detail.session.session_id }, req });
      return detail;
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions/:id/files/*',
    summary: 'Streams one file of a recording (Range supported). ?download=1 needs data.download; raw LiDAR / IMU always need data.download_restricted',
    tag,
    access: { can: 'robot.read', target: sessionRobot },
    query: z.object({ download: optionalBool }),
    handler: async ({ params, query, req, reply, user }) => {
      const owner = await visibleSession(user, params.id);
      const name = String(params['*'] ?? '');
      const file = await archive.file(params.id, name);
      const target = { type: 'robot' as const, id: owner.robotId };
      const restricted = file.kind === 'sensors';
      if (restricted) await assertCan(app, req, user, 'data.download_restricted', target);
      else if (query.download) await assertCan(app, req, user, 'data.download', target);
      if ((restricted || query.download) && firstBytes(req)) {
        app.audit.note({
          action: 'data.downloaded',
          actor: user,
          target: { type: 'recording', id: params.id },
          robotId: owner.robotId,
          detail: { file: name, kind: file.kind, sensor: file.sensor, size_bytes: file.size, restricted },
          req,
        });
      }
      try {
        const obj = await archive.storage.get(file.key, req.headers.range);
        return sendObject(reply, obj, contentTypeFor(name), query.download || restricted ? name.split('/').pop() : undefined);
      } catch (err) {
        return storageError(err, reply);
      }
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions/:id/cameras/:camera/playlist.m3u8',
    summary: 'HLS VOD playlist over one camera’s .ts segments (for the synced web player)',
    tag,
    access: { can: 'robot.read', target: sessionRobot },
    handler: async ({ params, reply, user }) => {
      await visibleSession(user, params.id);
      if (!isCameraName(params.camera)) throw badRequest('invalid camera name');
      const { segments } = await archive.cameraTrack(params.id, params.camera);
      if (!segments.length) throw notFound('video for this camera');
      const base = `/api/v1/archive/sessions/${params.id}/files/`;
      // EXT-X-DISCONTINUITY per chunk: the DVR may reset timestamps per file; this keeps hls.js from mis-placing segments.
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map((s) => s.duration)))}`, '#EXT-X-MEDIA-SEQUENCE:0'];
      segments.forEach((s, i) => {
        if (i > 0) lines.push('#EXT-X-DISCONTINUITY');
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.start).toISOString()}`, `#EXTINF:${s.duration.toFixed(3)},`, base + s.name.split('/').map(encodeURIComponent).join('/'));
      });
      lines.push('#EXT-X-ENDLIST', '');
      return reply.header('Content-Type', 'application/vnd.apple.mpegurl').header('Cache-Control', 'no-store').send(lines.join('\n'));
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions/:id/cameras/:camera/mp4',
    summary: 'One camera as a single MP4 download (plays on Windows, macOS, phones). Built with ffmpeg on first request, then cached',
    tag,
    access: { can: 'data.download', target: sessionRobot },
    query: z.object({ download: optionalBool }),
    handler: async ({ params, query, req, reply, user }) => {
      const owner = await visibleSession(user, params.id);
      if (!isCameraName(params.camera)) throw badRequest('invalid camera name');
      if (!(await archive.mp4.ffmpeg()).available) throw new ApiError(501, 'ffmpeg_missing', 'MP4 export needs ffmpeg on the backend host (set FFMPEG_PATH)');
      const { session, segments } = await archive.cameraTrack(params.id, params.camera);
      if (!segments.length) throw notFound('video for this camera');
      let file: string;
      try {
        file = await archive.mp4.build(session.robot_id, session.session_id, params.camera, segments);
      } catch (err) {
        req.log.error({ err }, 'mp4 build failed');
        throw new ApiError(502, 'mp4_failed', 'Could not build the MP4 from this camera’s video');
      }
      const size = (await stat(file)).size;
      const name = mp4Name(session.robot_id, session.session_id, params.camera);
      if (firstBytes(req)) {
        app.audit.note({ action: 'data.downloaded', actor: user, target: { type: 'recording', id: params.id }, robotId: owner.robotId, detail: { file: name, kind: 'mp4', camera: params.camera, size_bytes: size }, req });
      }
      reply
        .header('Content-Type', 'video/mp4')
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'private, max-age=300')
        .header('Content-Disposition', disposition(query.download ? 'attachment' : 'inline', name));
      try {
        const r = parseRange(req.headers.range, size);
        if (r) {
          reply.header('Content-Range', `bytes ${r.start}-${r.end}/${size}`).header('Content-Length', String(r.end - r.start + 1));
          return reply.code(206).send(createReadStream(file, { start: r.start, end: r.end }));
        }
      } catch (err) {
        return storageError(err, reply);
      }
      return reply.header('Content-Length', String(size)).code(200).send(createReadStream(file));
    },
  });

  // ── data dump: one zip of any recordings and data types ───────────────────
  route(f, app, {
    method: 'GET',
    path: '/archive/download.zip',
    summary:
      'Data dump: one zip of up to 200 recordings. include = video, imu, gps, lidar, encoder, meta (default: everything you may download); cameras limits video. Folders: <robot>/<session>/…',
    tag,
    access: { can: 'robot.read', target: anyScope() },
    query: z.object({
      sessions: z.string().min(1).max(200 * 40),
      include: z.string().max(200).optional(),
      cameras: z.string().max(200).optional(),
    }),
    handler: async ({ query, req, reply, user }) => {
      const ids = [...new Set(query.sessions.split(',').map((x) => x.trim()).filter(Boolean))];
      if (ids.length > 200) throw badRequest('at most 200 recordings per download');
      const asked = query.include ? [...new Set(query.include.split(',').map((x) => x.trim()).filter(Boolean))] : null;
      for (const g of asked ?? []) if (!(ZIP_GROUPS as readonly string[]).includes(g)) throw badRequest(`unknown data type ${g}; use ${ZIP_GROUPS.join(', ')}`);
      const cams = query.cameras ? new Set(query.cameras.split(',').map((x) => x.trim())) : null;

      // Every recording must be visible to the user, and each requested type downloadable on its robot.
      const plan: { robotId: string; sessionId: string; files: Awaited<ReturnType<typeof archive.files>> }[] = [];
      const groupsUsed = new Set<ZipGroup>();
      for (const id of ids) {
        const owner = await visibleSession(user, id);
        const target = { type: 'robot' as const, id: owner.robotId };
        const access = await accessFor(user, owner.robotId);
        const allowed = ZIP_GROUPS.filter((g) => (SENSOR_GROUPS.has(g) ? access.download_restricted : access.download));
        const groups = (asked ?? allowed) as ZipGroup[];
        if (asked) {
          if (groups.some((g) => SENSOR_GROUPS.has(g))) await assertCan(app, req, user, 'data.download_restricted', target);
          if (groups.some((g) => !SENSOR_GROUPS.has(g))) await assertCan(app, req, user, 'data.download', target);
        } else if (!groups.length) {
          await assertCan(app, req, user, 'data.download', target);
        }
        const want = new Set<string>(groups);
        const files = (await archive.files(id)).filter((fl) =>
          fl.kind === 'camera' ? want.has('video') && (!cams || cams.has(fl.camera!)) : fl.kind === 'meta' ? want.has('meta') : want.has(fl.sensor!),
        );
        for (const fl of files) groupsUsed.add(fl.kind === 'camera' ? 'video' : fl.kind === 'meta' ? 'meta' : (fl.sensor as ZipGroup));
        const sessionId = (await app.db.query<{ session_id: string }>('SELECT session_id FROM archive_sessions WHERE id = $1', [id])).rows[0].session_id;
        if (files.length) plan.push({ robotId: owner.robotId, sessionId, files });
      }
      const count = plan.reduce((n, p) => n + p.files.length, 0);
      if (!count) throw notFound('files for this selection');

      const robots = [...new Set(plan.map((p) => p.robotId))];
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `${robots.length === 1 ? robots[0] : 'arnobot'}_${plan.length === 1 ? plan[0].sessionId : `${plan.length}-recordings`}_${stamp}.zip`;
      const bytes = plan.reduce((n, p) => n + p.files.reduce((m, x) => m + x.size_bytes, 0), 0);
      const restricted = [...groupsUsed].some((g) => SENSOR_GROUPS.has(g));
      for (const robotId of robots) {
        const mine = plan.filter((p) => p.robotId === robotId);
        app.audit.note({
          action: 'data.downloaded',
          actor: user,
          target: { type: 'robot', id: robotId },
          robotId,
          detail: { zip: true, recordings: mine.map((p) => p.sessionId), include: [...groupsUsed], cameras: cams ? [...cams] : null, files: mine.reduce((n, p) => n + p.files.length, 0), size_bytes: bytes, restricted },
          req,
        });
      }

      const out = new PassThrough();
      const zip = new ZipWriter(out);
      let aborted = false;
      req.raw.on('close', () => {
        if (!reply.raw.writableFinished) {
          aborted = true;
          out.destroy();
        }
      });
      reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', disposition('attachment', name))
        .header('Cache-Control', 'private, no-store')
        .header('X-Archive-Files', String(count));
      reply.send(out);
      // One S3 object at a time: memory and S3 connections stay flat, whatever the dump size.
      void (async () => {
        try {
          for (const p of plan) {
            for (const fl of p.files) {
              if (aborted) return;
              const obj = await archive.storage.get(fl.object_key);
              await zip.add(`${p.robotId}/${p.sessionId}/${fl.name}`, obj.body, obj.lastModified ?? new Date());
            }
          }
          if (!aborted) await zip.finish();
        } catch (err) {
          req.log.error({ err }, 'zip download failed');
          out.destroy(err as Error);
        }
      })();
      return reply;
    },
  });

  // ── sensor previews: view LiDAR / IMU without the raw files ───────────────
  route(f, app, {
    method: 'GET',
    path: '/archive/sessions/:id/sensors/imu',
    summary: 'IMU preview: every chunk merged and down-sampled (accel, gyro, attitude). status/problem explain missing or unreadable data',
    tag,
    access: { can: 'data.sensors', target: sessionRobot },
    handler: async ({ params, user }): Promise<ImuPreviewDto> => {
      await visibleSession(user, params.id);
      return archive.imuPreview(params.id);
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions/:id/sensors/lidar',
    summary: 'LiDAR preview of one chunk (default the first): scans spread over it, points as [angle_deg, range_m]',
    tag,
    access: { can: 'data.sensors', target: sessionRobot },
    query: z.object({ chunk: z.string().max(300).optional() }),
    handler: async ({ params, query, user }): Promise<LidarPreviewDto> => {
      await visibleSession(user, params.id);
      return archive.lidarPreview(params.id, query.chunk);
    },
  });

  // ── delete / restore ──────────────────────────────────────────────────────
  route(f, app, {
    method: 'DELETE',
    path: '/archive/sessions/:id',
    summary: 'Delete a recording: hidden everywhere (the files stay in the bucket, so it can be restored)',
    tag,
    access: { can: 'data.delete', target: sessionRobot },
    body: z.object({ reason: nullableText(500).optional() }).optional(),
    handler: async ({ params, body, user, req }) => {
      const owner = await visibleSession(user, params.id);
      await archive.setDeleted(params.id, true, user.id, body?.reason ?? null);
      await app.audit.record({ action: 'data.deleted', actor: user, target: { type: 'recording', id: params.id }, robotId: owner.robotId, detail: { reason: body?.reason ?? null }, req });
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/archive/sessions/:id/restore',
    summary: 'Restore a deleted recording',
    tag,
    access: { can: 'data.delete', target: sessionRobot },
    handler: async ({ params, user, req }) => {
      const owner = await visibleSession(user, params.id, true);
      await archive.setDeleted(params.id, false, user.id, null);
      await app.audit.record({ action: 'data.restored', actor: user, target: { type: 'recording', id: params.id }, robotId: owner.robotId, req });
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/archive/reindex',
    summary: 'Rebuild the archive index from the object store (registered robots only; store is the source of truth)',
    tag,
    access: { can: 'ingest.manage', target: platform() },
    body: reindexBody,
    handler: ({ body }): Promise<ArchiveReindexDto> => archive.reindex(body.robot_id ?? null, body.full ?? false),
  });
}
