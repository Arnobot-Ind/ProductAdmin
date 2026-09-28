import type { MissionDetailDto, MissionFileDto, MissionListItemDto, Paginated } from '../shared';
import { MISSION_STATES } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { notFound } from '../lib/errors';
import { anyScope, robotParam, robotVia, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { isoDateTime, pageQuery, robotIdSchema } from '../lib/validation';

const LIST_SELECT = `
SELECT m.mission_id, m.robot_id, m.name, m.started_at, m.ended_at, m.duration_s, m.distance_m, m.result, m.end_reason,
       (SELECT count(*)::int FROM mission_files mf WHERE mf.mission_id = m.mission_id) AS file_count,
       (m.gcs_report IS NOT NULL) AS has_gcs_report
FROM missions m JOIN robots r ON r.robot_id = m.robot_id`;
const toItem = (r: Record<string, unknown>): MissionListItemDto => ({
  ...(r as unknown as MissionListItemDto),
  started_at: iso(r.started_at as Date | null),
  ended_at: iso(r.ended_at as Date | null),
});
const listQuery = z.object({
  robot: robotIdSchema.optional(),
  result: z.enum(MISSION_STATES).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  ...pageQuery,
});

/** Mission reports (spec §3 row 12, §5). Created by the GCS; append-only; totals are computed. */
export function missionRoutes(f: FastifyInstance, app: AppContext): void {
  const { db, robots, storage } = app;
  const tag = 'Missions';

  const list = (q: z.infer<typeof listQuery>, w: Where): Promise<Paginated<MissionListItemDto>> => {
    if (q.robot) w.add('m.robot_id = ?', q.robot);
    if (q.result) w.add('m.result = ?', q.result);
    if (q.from) w.add('coalesce(m.started_at, m.created_at) >= ?', q.from);
    if (q.to) w.add('coalesce(m.started_at, m.created_at) < ?', q.to);
    return paginate(db, LIST_SELECT, w, 'm.started_at DESC NULLS LAST, m.created_at DESC', q.page, q.limit, toItem) as Promise<Paginated<MissionListItemDto>>;
  };

  route(f, app, {
    method: 'GET',
    path: '/missions',
    summary: 'Missions across all robots the user may read',
    tag,
    access: { can: 'robot.read', target: anyScope() },
    query: listQuery,
    handler: ({ query, user }) => list(query, app.perms.applyRobotScope(new Where(), app.perms.robotScope(user, 'robot.read'), 'm.robot_id')),
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/missions',
    summary: 'Missions of one robot (spec §5 view 2)',
    tag,
    access: { can: 'robot.read', target: robotParam() },
    query: listQuery,
    handler: async ({ params, query }) => {
      await robots.assertExists(params.robotId, { allowDeleted: true });
      return list({ ...query, robot: undefined }, new Where().add('m.robot_id = ?', params.robotId));
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/missions/:missionId',
    summary: 'Mission detail: planned + actual path, stats, files (spec §5 view 3)',
    tag,
    access: { can: 'robot.read', target: robotVia('SELECT robot_id FROM missions WHERE mission_id = $1', 'mission', 'missionId', false) },
    handler: async ({ params }): Promise<MissionDetailDto> => {
      const m = (
        await db.query(
          `SELECT m.*, (SELECT count(*)::int FROM mission_files mf WHERE mf.mission_id = m.mission_id) AS file_count,
                  (m.gcs_report IS NOT NULL) AS has_gcs_report
           FROM missions m WHERE m.mission_id = $1`,
          [params.missionId],
        )
      ).rows[0];
      if (!m) throw notFound('mission');
      const files = await db.query(
        `SELECT mf.id, mf.kind, mf.s3_path, coalesce(mf.size_bytes, f.size_bytes) AS size_bytes,
                coalesce(mf.content_type, f.content_type) AS content_type, mf.file_id, mf.created_at
         FROM mission_files mf LEFT JOIN files f ON f.id = mf.file_id WHERE mf.mission_id = $1 ORDER BY mf.kind, mf.created_at`,
        [params.missionId],
      );
      const fileDtos: MissionFileDto[] = files.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        s3_path: r.s3_path,
        size_bytes: r.size_bytes,
        content_type: r.content_type,
        // Download goes through the API (auth + permission), which redirects to a short-lived link.
        download_url: r.file_id || (storage.driver === 's3' && r.s3_path.startsWith('s3://')) ? `/api/v1/mission-files/${r.id}/download` : null,
        created_at: iso(r.created_at)!,
      }));
      return {
        mission_id: m.mission_id,
        robot_id: m.robot_id,
        name: m.name,
        started_at: iso(m.started_at),
        ended_at: iso(m.ended_at),
        duration_s: m.duration_s,
        distance_m: m.distance_m,
        result: m.result,
        end_reason: m.end_reason,
        file_count: m.file_count,
        has_gcs_report: m.has_gcs_report,
        planned_path: m.planned_path,
        actual_path: m.actual_path,
        distance_planned_m: m.distance_planned_m,
        waypoints_total: m.waypoints_total,
        waypoints_reached: m.waypoints_reached,
        files: fileDtos,
        gcs_report_received_at: iso(m.gcs_report_received_at),
        created_at: iso(m.created_at)!,
        updated_at: iso(m.updated_at)!,
      };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/mission-files/:id/download',
    summary: 'Download a mission file (redirect to a 5-minute presigned link)',
    tag,
    access: {
      can: 'robot.read',
      target: robotVia('SELECT m.robot_id FROM mission_files mf JOIN missions m ON m.mission_id = mf.mission_id WHERE mf.id = $1', 'mission file'),
    },
    handler: async ({ params, reply }) => {
      const r = (await db.query<{ file_id: string | null; s3_path: string }>('SELECT file_id, s3_path FROM mission_files WHERE id = $1', [params.id])).rows[0];
      if (r.file_id) return app.files.send(r.file_id, reply);
      const url = await storage.presignExternal(r.s3_path);
      if (!url) throw notFound('file content (this S3 path is not reachable from the PMS storage configuration)');
      return reply.redirect(url, 302);
    },
  });
}
