/**
 * Video / sensor archive for the admin panel. Every read is scoped to the robot that recorded it
 * (robot.read on that robot); files, playlists and MP4s stream through the backend with Range support,
 * so the bucket stays private and the browser never sees a storage URL.
 */
import type { FastifyReply } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ArchiveReindexDto, ArchiveSessionDetailDto, ArchiveSessionListDto, RobotArchiveDto } from '../shared';
import type { AppContext } from '../context';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { anyScope, platform, robotParam, robotVia, route } from '../lib/route';
import { optionalBool, pageQuery, robotIdSchema } from '../lib/validation';
import { contentTypeFor, isCameraName } from '../services/archive/keys';
import { mp4Name } from '../services/archive/mp4';
import { ObjectNotFound, parseRange, RangeNotSatisfiable, type ObjectStream } from '../services/archive/storage';

const listQuery = z.object({
  robot: robotIdSchema.optional(),
  product: z.string().max(50).optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'closed', 'interrupted']).optional(),
  include_sim: optionalBool,
  ...pageQuery,
});
const reindexBody = z.object({ robot_id: robotIdSchema.optional(), full: z.boolean().optional() }).strict();

const sessionRobot = robotVia('SELECT robot_id FROM archive_sessions WHERE id = $1', 'recording');

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

export function archiveRoutes(f: FastifyInstance, app: AppContext): void {
  const tag = 'Archive';
  const { archive } = app;

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions',
    summary: 'Recorded sessions (video + sensors) across the robots you can read, newest first',
    tag,
    access: { can: 'robot.read', target: anyScope() },
    query: listQuery,
    handler: ({ query: q, user }): Promise<ArchiveSessionListDto> =>
      archive.listSessions({ ...q, include_sim: q.include_sim ?? false }, (w) => app.perms.applyRobotScope(w, app.perms.robotScope(user, 'robot.read'), 's.robot_id')),
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/archive',
    summary: 'One robot’s recorded sessions and its upload link (heartbeat, backlog, alerts)',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    handler: async ({ params }): Promise<RobotArchiveDto> => {
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      return archive.robotArchive(params.robotId);
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions/:id',
    summary: 'One recording: summary, cameras (segments for the player, MP4 links) and every file',
    tag,
    access: { can: 'robot.read', target: sessionRobot },
    handler: ({ params }): Promise<ArchiveSessionDetailDto> => archive.detail(params.id),
  });

  route(f, app, {
    method: 'GET',
    path: '/archive/sessions/:id/files/*',
    summary: 'Streams one file of a recording (Range supported; ?download=1 saves it)',
    tag,
    access: { can: 'robot.read', target: sessionRobot },
    query: z.object({ download: optionalBool }),
    handler: async ({ params, query, req, reply }) => {
      const name = String(params['*'] ?? '');
      const file = await archive.file(params.id, name);
      try {
        const obj = await archive.storage.get(file.key, req.headers.range);
        return sendObject(reply, obj, contentTypeFor(name), query.download ? name.split('/').pop() : undefined);
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
    handler: async ({ params, reply }) => {
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
    summary: 'One camera as a single MP4 (plays on Windows, macOS, phones). Built with ffmpeg on first request, then cached',
    tag,
    access: { can: 'robot.read', target: sessionRobot },
    query: z.object({ download: optionalBool }),
    handler: async ({ params, query, req, reply }) => {
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
