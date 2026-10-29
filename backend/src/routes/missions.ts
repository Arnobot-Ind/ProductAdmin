import type { MissionDetailDto, MissionFileDto, MissionListItemDto, MissionPeriodStatsDto, MissionWaypointDto, Paginated } from '../shared';
import { MISSION_STATES } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { notFound } from '../lib/errors';
import { anyScope, assertCan, robotParam, robotVia, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { isoDateTime, pageQuery, robotIdSchema } from '../lib/validation';

const LIST_SELECT = `
SELECT m.mission_id, m.robot_id, m.name, m.started_at, m.ended_at, m.duration_s, m.distance_m, m.distance_planned_m,
       m.waypoints_total, m.waypoints_reached, m.result, m.end_reason,
       (SELECT count(*)::int FROM mission_files mf WHERE mf.mission_id = m.mission_id) AS file_count,
       (m.gcs_report IS NOT NULL) AS has_gcs_report
FROM missions m JOIN robots r ON r.robot_id = m.robot_id`;
/**
 * Waypoints from the GCS report as stored (`waypoints` or `report_data.waypoints`, as the GCS writes them):
 * { sequence, label, lat, lng|lon, reached, reached_at }. null when the report has none.
 */
export function reportWaypoints(report: unknown): MissionWaypointDto[] | null {
  const r = report as { waypoints?: unknown; report_data?: { waypoints?: unknown } } | null;
  const list = Array.isArray(r?.waypoints) ? r!.waypoints : Array.isArray(r?.report_data?.waypoints) ? r!.report_data!.waypoints : null;
  if (!list) return null;
  const out: MissionWaypointDto[] = [];
  (list as Record<string, unknown>[]).forEach((w, i) => {
    const lat = Number(w.lat ?? w.latitude);
    const lng = Number(w.lng ?? w.lon ?? w.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const at = typeof w.reached_at === 'string' && !Number.isNaN(Date.parse(w.reached_at)) ? new Date(w.reached_at).toISOString() : null;
    out.push({
      sequence: Number.isFinite(Number(w.sequence)) ? Number(w.sequence) : i + 1,
      label: typeof w.label === 'string' && w.label ? w.label : null,
      lat,
      lng,
      reached: w.reached === true || at !== null,
      reached_at: at,
    });
  });
  return out.sort((a, b) => a.sequence - b.sequence);
}

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
    access: { can: 'robot.details', target: anyScope() },
    query: listQuery,
    // Organizations never see missions flown while another customer owned the robot.
    handler: ({ query, user }) => list(query, app.perms.applyDataScope(new Where(), app.perms.robotScope(user, 'robot.details'), 'm.robot_id', 'coalesce(m.started_at, m.created_at)')),
  });

  route(f, app, {
    method: 'GET',
    path: '/missions/stats',
    summary: 'Missions over [from, to) (both optional: all time): totals, per robot, and per IST hour, day or month',
    tag,
    access: { can: 'robot.details', target: anyScope() },
    query: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() }),
    handler: async ({ query, user }): Promise<MissionPeriodStatsDto> => {
      const T = 'coalesce(m.started_at, m.created_at)';
      const scoped = () => {
        const w = app.perms.applyDataScope(new Where(), app.perms.robotScope(user, 'robot.details'), 'm.robot_id', T);
        w.add('EXISTS (SELECT 1 FROM robots rr WHERE rr.robot_id = m.robot_id AND rr.deleted_at IS NULL)');
        if (query.from) w.add(`${T} >= ?`, query.from);
        if (query.to) w.add(`${T} < ?`, query.to);
        return w;
      };
      const COUNTS = `count(*)::int AS total, count(*) FILTER (WHERE m.result = 'completed')::int AS completed,
        count(*) FILTER (WHERE m.result = 'aborted')::int AS aborted, count(*) FILTER (WHERE m.result = 'failed')::int AS failed,
        count(*) FILTER (WHERE m.result = 'in_progress' OR m.result IS NULL)::int AS in_progress`;
      const tw = scoped();
      const t = (
        await db.query(
          `SELECT ${COUNTS}, coalesce(sum(m.distance_m), 0)::float8 AS distance_m, coalesce(sum(m.duration_s), 0)::float8 AS duration_s, min(${T}) AS first, max(${T}) AS last
           FROM missions m ${tw.toSql()}`,
          tw.params,
        )
      ).rows[0];
      const rw = scoped();
      const robots = (
        await db.query(
          `SELECT m.robot_id, p.category, ${COUNTS} FROM missions m JOIN robots r ON r.robot_id = m.robot_id JOIN products p ON p.id = r.product_id
           ${rw.toSql()} GROUP BY m.robot_id, p.category ORDER BY total DESC, m.robot_id LIMIT 50`,
          rw.params,
        )
      ).rows;

      // Bucket size from the period's length (all time: from the first mission).
      const start = query.from ? new Date(query.from) : t.first ? new Date(t.first) : new Date();
      const end = query.to ? new Date(query.to) : new Date();
      const span = end.getTime() - start.getTime();
      const granularity: MissionPeriodStatsDto['granularity'] = span <= 48 * 3_600_000 ? 'hour' : span <= 92 * 86_400_000 ? 'day' : 'month';
      const IST = "AT TIME ZONE 'Asia/Kolkata'";
      const key = granularity === 'hour' ? `to_char(${T} ${IST}, 'YYYY-MM-DD"T"HH24')` : granularity === 'day' ? `to_char(${T} ${IST}, 'YYYY-MM-DD')` : `to_char(${T} ${IST}, 'YYYY-MM')`;
      const bw = scoped();
      const rows = (await db.query(`SELECT ${key} AS k, ${COUNTS} FROM missions m ${bw.toSql()} GROUP BY 1`, bw.params)).rows as { k: string; completed: number; aborted: number; failed: number; in_progress: number }[];
      const found = new Map(rows.map((r) => [r.k, r]));
      const ist = (d: Date) => new Date(d.getTime() + 19_800_000).toISOString();
      const keys: string[] = [];
      if (granularity === 'hour') {
        for (let x = Math.floor((start.getTime() + 19_800_000) / 3_600_000) * 3_600_000 - 19_800_000; x < end.getTime(); x += 3_600_000) keys.push(ist(new Date(x)).slice(0, 13));
      } else if (granularity === 'day') {
        for (let d = ist(start).slice(0, 10); d <= ist(new Date(end.getTime() - 1)).slice(0, 10); d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) keys.push(d);
      } else {
        const last = ist(new Date(end.getTime() - 1)).slice(0, 7);
        for (let mth = ist(start).slice(0, 7); mth <= last; ) {
          keys.push(mth);
          const [y, mo] = mth.split('-').map(Number);
          mth = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
        }
      }
      const buckets = keys.map((k) => {
        const r = found.get(k);
        return { start: granularity === 'hour' ? `${k}:00:00+05:30` : k, completed: r?.completed ?? 0, aborted: r?.aborted ?? 0, failed: r?.failed ?? 0, in_progress: r?.in_progress ?? 0 };
      });
      return {
        from: query.from ?? null,
        to: query.to ?? null,
        totals: { total: t.total, completed: t.completed, aborted: t.aborted, failed: t.failed, in_progress: t.in_progress, distance_m: t.distance_m, duration_s: t.duration_s },
        robots,
        granularity,
        buckets,
      };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/missions',
    summary: 'Missions of one robot (spec §5 view 2)',
    tag,
    access: { can: 'robot.details', target: robotParam() },
    query: listQuery,
    handler: async ({ params, query, user }) => {
      await robots.assertExists(params.robotId, { allowDeleted: true });
      const w = new Where().add('m.robot_id = ?', params.robotId);
      return list({ ...query, robot: undefined }, app.perms.applyDataScope(w, app.perms.robotScope(user, 'robot.details'), 'm.robot_id', 'coalesce(m.started_at, m.created_at)'));
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/missions/:missionId',
    summary: 'Mission detail: planned + actual path, stats, files (spec §5 view 3)',
    tag,
    access: { can: 'robot.details', target: robotVia('SELECT robot_id FROM missions WHERE mission_id = $1', 'mission', 'missionId', false) },
    handler: async ({ params, user }): Promise<MissionDetailDto> => {
      const m = (
        await db.query(
          `SELECT m.*, (SELECT count(*)::int FROM mission_files mf WHERE mf.mission_id = m.mission_id) AS file_count,
                  (m.gcs_report IS NOT NULL) AS has_gcs_report
           FROM missions m WHERE m.mission_id = $1`,
          [params.missionId],
        )
      ).rows[0];
      if (!m || !(await app.perms.canSeeData(user, 'robot.details', m.robot_id, m.started_at ?? m.created_at))) throw notFound('mission');
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
        waypoints: reportWaypoints(m.gcs_report),
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
      can: 'robot.details',
      target: robotVia('SELECT m.robot_id FROM mission_files mf JOIN missions m ON m.mission_id = mf.mission_id WHERE mf.id = $1', 'mission file'),
    },
    handler: async ({ params, req, reply, user }) => {
      const r = (
        await db.query<{ file_id: string | null; s3_path: string; kind: string; robot_id: string; at: Date }>(
          `SELECT mf.file_id, mf.s3_path, mf.kind, m.robot_id, coalesce(m.started_at, m.created_at) AS at
           FROM mission_files mf JOIN missions m ON m.mission_id = mf.mission_id WHERE mf.id = $1`,
          [params.id],
        )
      ).rows[0];
      if (!(await app.perms.canSeeData(user, 'robot.details', r.robot_id, r.at))) throw notFound('mission file');
      // Photos and video play inline for anyone who may view the mission; every other file is a download.
      const viewable = r.kind === 'image' || r.kind === 'video';
      if (!viewable) {
        // Raw sensor recordings (LiDAR, MCAP bags) are restricted data.
        const permission = r.kind === 'lidar' || r.kind === 'mcap' ? 'data.download_restricted' : 'data.download';
        await assertCan(app, req, user, permission, { type: 'robot', id: r.robot_id });
        app.audit.note({ action: 'data.downloaded', actor: user, target: { type: 'mission_file', id: params.id }, robotId: r.robot_id, detail: { kind: r.kind, path: r.s3_path }, req });
      }
      if (r.file_id) return app.files.send(r.file_id, reply);
      const url = await storage.presignExternal(r.s3_path);
      if (!url) throw notFound('file content (this S3 path is not reachable from the PMS storage configuration)');
      return reply.redirect(url, 302);
    },
  });
}
