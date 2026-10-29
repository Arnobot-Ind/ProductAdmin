import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { forbidden } from '../lib/errors';
import { robotParam, route } from '../lib/route';
import { Where } from '../lib/sql';
import { isoDateTime, optionalBool, pageQuery } from '../lib/validation';
import { LOG_LEVEL_GROUPS, ROBOT_LOG_KINDS, type LogLevelGroup, type RobotActivityDayDto, type RobotLogDto, type RobotLogKind } from '../shared';

/**
 * One SELECT per log source, all with the same columns, so they can be merged into a single timeline.
 * `$1` is always the robot ID. Every branch is filtered by robot inside, so each source uses its own index.
 */
const SOURCES: Record<RobotLogKind, string> = {
  note: `SELECT n.created_at, 'note', 'info', CASE WHEN n.pinned THEN 'Pinned note' ELSE 'Note' END, n.body, n.id::text, u.name
         FROM robot_notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.robot_id = $1 AND n.deleted_at IS NULL`,
  event: `SELECT e.ts AS ts, 'event' AS kind, e.severity AS level, coalesce(e.code, e.type) AS title, e.message AS body,
                 e.id::text AS ref, CASE WHEN e.acknowledged_at IS NOT NULL THEN 'acknowledged' END AS actor
          FROM events e WHERE e.robot_id = $1`,
  mission: `SELECT coalesce(m.ended_at, m.started_at, m.created_at), 'mission',
                   CASE m.result WHEN 'completed' THEN 'ok' WHEN 'failed' THEN 'critical' WHEN 'aborted' THEN 'warning' ELSE 'info' END,
                   'Mission ' || replace(coalesce(m.result, 'in_progress'), '_', ' ') || ': ' || coalesce(m.name, m.mission_id::text),
                   concat_ws(' · ', CASE WHEN m.distance_m IS NOT NULL THEN round(m.distance_m)::text || ' m' END, m.end_reason),
                   m.mission_id::text, NULL
            FROM missions m WHERE m.robot_id = $1`,
  hardware: `SELECT h.fitted_at::timestamptz, 'hardware', 'info', 'Fitted ' || pt.name || coalesce(' ' || h.slot, ''),
                    concat_ws(' · ', h.model, 'SN ' || h.serial_number, h.notes), h.id::text, NULL
             FROM hardware_fitted h JOIN part_types pt ON pt.id = h.part_type_id WHERE h.robot_id = $1 AND h.fitted_at IS NOT NULL
             UNION ALL
             SELECT h.removed_at::timestamptz, 'hardware', 'warning', 'Removed ' || pt.name || coalesce(' ' || h.slot, ''),
                    concat_ws(' · ', h.model, 'SN ' || h.serial_number, h.removal_reason), h.id::text, NULL
             FROM hardware_fitted h JOIN part_types pt ON pt.id = h.part_type_id WHERE h.robot_id = $1 AND h.removed_at IS NOT NULL
             UNION ALL
             SELECT ra.fitted_at, 'hardware', 'info', 'Attachment fitted: ' || a.name || coalesce(' ' || ah.name, ''), concat_ws(' · ', 'SN ' || ra.serial_number, ra.notes), ra.id::text, NULL
             FROM robot_attachments ra JOIN attachments a ON a.id = ra.attachment_id LEFT JOIN hardware_revisions ah ON ah.id = ra.hardware_revision_id WHERE ra.robot_id = $1
             UNION ALL
             SELECT ra.removed_at, 'hardware', 'warning', 'Attachment removed: ' || a.name || coalesce(' ' || ah.name, ''), concat_ws(' · ', 'SN ' || ra.serial_number, ra.removal_note), ra.id::text, NULL
             FROM robot_attachments ra JOIN attachments a ON a.id = ra.attachment_id LEFT JOIN hardware_revisions ah ON ah.id = ra.hardware_revision_id WHERE ra.robot_id = $1 AND ra.removed_at IS NOT NULL`,
  maintenance: `SELECT ml.repaired_at::timestamptz, 'maintenance', 'info', 'Repair',
                       concat_ws(' · ', ml.description, 'removed SN ' || ml.part_removed_serial, 'fitted SN ' || ml.part_fitted_serial, 'by ' || ml.repaired_by),
                       ml.id::text, NULL
                FROM maintenance_log ml WHERE ml.robot_id = $1 AND ml.deleted_at IS NULL`,
  software: `SELECT s.reported_at, 'software', 'info', 'Software ' || coalesce(s.sw_ver, 'version not reported') || coalesce(' · firmware ' || s.fw_ver, ''),
                    concat_ws(' · ', s.source, s.note), s.id::text, NULL
             FROM software_history s WHERE s.robot_id = $1`,
  ownership: `SELECT o.valid_from, 'ownership', 'info', 'Owner: ' || c.name, o.reason, o.id::text, NULL
              FROM company_assignment_history o JOIN companies c ON c.id = o.company_id WHERE o.robot_id = $1`,
  document: `SELECT v.uploaded_at, 'document', 'info', 'Document v' || v.version_no || ': ' || d.title, v.note, d.id::text, NULL
             FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.robot_id = $1`,
  audit: `SELECT a.at, 'audit', CASE WHEN a.outcome = 'success' THEN 'info' ELSE 'warning' END, a.action,
                 CASE WHEN a.outcome = 'success' THEN NULL ELSE a.outcome END, a.id::text, a.actor_email
          FROM audit_log a WHERE a.robot_id = $1`,
  message: `SELECT im.ts, 'message', 'info', im.type, im.transport, im.msg_id::text, NULL
            FROM ingested_messages im WHERE im.robot_id = $1`,
  rejection: `SELECT r.received_at, 'rejection', 'warning', 'Rejected ' || coalesce(r.type, 'message'), r.error, r.id::text, NULL
              FROM ingest_rejections r WHERE r.robot_id = $1`,
};

/** Sources that need a permission beyond robot.details. */
const EXTRA_PERMISSION: Partial<Record<RobotLogKind, string>> = { audit: 'audit.read', message: 'ingest.read', rejection: 'ingest.read' };

const kindsParam = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter((k): k is RobotLogKind => (ROBOT_LOG_KINDS as readonly string[]).includes(k)) : undefined));

const levelsParam = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter((k): k is LogLevelGroup => k in LOG_LEVEL_GROUPS) : undefined));
/** Severity group of a log entry's level, in SQL (critical / warning / info). */
const LEVEL_GROUP_SQL = `CASE WHEN l.level IN (${LOG_LEVEL_GROUPS.critical.map((x) => `'${x}'`).join(', ')}) THEN 'critical' WHEN l.level = 'warning' THEN 'warning' ELSE 'info' END`;

/** A robot's activity log: everything that happened to it, newest first, from every log table (admin panel). */
export function robotLogRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/log',
    summary: "One robot's activity log: events, missions, hardware, repairs, software, ownership, documents, audit and robot messages merged newest first",
    tag: 'Robots',
    access: { can: 'robot.details', target: robotParam() },
    query: z.object({ ...pageQuery, kinds: kindsParam, levels: levelsParam, q: z.string().trim().max(200).optional(), from: isoDateTime.optional(), to: isoDateTime.optional(), include_messages: optionalBool }),
    handler: async ({ params, query, user }): Promise<RobotLogDto> => {
      // Staff view: a customer user's scope would also need their ownership window applied to every source.
      if (!(await app.perms.can(user, 'robot.details', { type: 'platform' }))) throw forbidden('the activity log is for Arnobot staff');
      await app.robots.assertExists(params.robotId, { allowDeleted: true });

      const target = { type: 'robot', id: params.robotId } as const;
      const allowed: RobotLogKind[] = [];
      for (const k of ROBOT_LOG_KINDS) {
        const need = EXTRA_PERMISSION[k];
        if (!need || (await app.perms.can(user, need, target))) allowed.push(k);
      }
      // Raw messages are many (every telemetry packet): only on request.
      const available = allowed.filter((k) => k !== 'message' || query.include_messages);
      const kinds = (query.kinds ?? available).filter((k) => available.includes(k));

      const filters = (w: Where) => {
        if (query.from) w.add('l.ts >= ?', query.from);
        if (query.to) w.add('l.ts < ?', query.to);
        if (query.q) w.add("(l.title || ' ' || coalesce(l.body, '') || ' ' || coalesce(l.actor, '')) ILIKE ?", `%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
        return w;
      };
      // Each source is wrapped with the same column names and types, so any subset can be merged in any order.
      const union = (ks: RobotLogKind[]) =>
        ks
          .map((k) => `SELECT x.ts::timestamptz, x.kind::text, x.level::text, x.title::text, x.body::text, x.ref::text, x.actor::text FROM (${SOURCES[k]}) AS x(ts, kind, level, title, body, ref, actor)`)
          .join(' UNION ALL ');

      // Counts per kind for the filter chips (date and text filters applied, kind filter not).
      const cw = filters(new Where([params.robotId]));
      const countRows = available.length
        ? (await db.query<{ kind: RobotLogKind; n: number }>(`SELECT l.kind, count(*)::int AS n FROM (${union(available)}) AS l(ts, kind, level, title, body, ref, actor) ${cw.toSql()} GROUP BY l.kind`, cw.params)).rows
        : [];
      const counts = Object.fromEntries(available.map((k) => [k, countRows.find((r) => r.kind === k)?.n ?? 0])) as Partial<Record<RobotLogKind, number>>;

      const noLevels: Record<LogLevelGroup, number> = { critical: 0, warning: 0, info: 0 };
      if (!kinds.length) return { items: [], total: 0, page: query.page, limit: query.limit, counts, available: allowed, level_counts: noLevels };
      // Counts per severity group for the chosen kinds (the severity filter itself not applied).
      const lw = filters(new Where([params.robotId]));
      const levelRows = (
        await db.query<{ g: LogLevelGroup; n: number }>(`SELECT ${LEVEL_GROUP_SQL} AS g, count(*)::int AS n FROM (${union(kinds)}) AS l(ts, kind, level, title, body, ref, actor) ${lw.toSql()} GROUP BY 1`, lw.params)
      ).rows;
      const levelCounts = { ...noLevels, ...Object.fromEntries(levelRows.map((r) => [r.g, r.n])) };
      const levels = query.levels?.length ? query.levels : null;
      const w = filters(new Where([params.robotId]));
      if (levels) w.add(`${LEVEL_GROUP_SQL} = ANY(?)`, levels);
      const total = levels ? levels.reduce((s, g) => s + levelCounts[g], 0) : kinds.reduce((s, k) => s + (counts[k] ?? 0), 0);
      const p = [...w.params, query.limit, (query.page - 1) * query.limit];
      const rows = (
        await db.query<{ ts: Date; kind: RobotLogKind; level: string; title: string; body: string | null; ref: string; actor: string | null }>(
          `SELECT l.* FROM (${union(kinds)}) AS l(ts, kind, level, title, body, ref, actor) ${w.toSql()} ORDER BY l.ts DESC NULLS LAST, l.kind, l.ref LIMIT $${p.length - 1} OFFSET $${p.length}`,
          p,
        )
      ).rows;
      return {
        items: rows.map((r) => ({ ts: r.ts ? r.ts.toISOString() : null, kind: r.kind, level: r.level, title: r.title, body: r.body || null, ref: r.ref, actor: r.actor })),
        total,
        page: query.page,
        limit: query.limit,
        counts,
        available: allowed,
        level_counts: levelCounts,
      };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/robots/:robotId/activity/calendar',
    summary: "One robot's activity per IST day of a month: recordings, missions, events, people detections and log entries (calendar of the Recordings and Logs tabs)",
    tag: 'Robots',
    access: { can: 'robot.details', target: robotParam() },
    query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM') }),
    handler: async ({ params, query, user }): Promise<RobotActivityDayDto[]> => {
      if (!(await app.perms.can(user, 'robot.details', { type: 'platform' }))) throw forbidden('the activity calendar is for Arnobot staff');
      await app.robots.assertExists(params.robotId, { allowDeleted: true });
      const [y, m] = query.month.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      const range = [params.robotId, `${query.month}-01T00:00:00+05:30`, `${next}-01T00:00:00+05:30`];
      const DAY = (col: string) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date::text`;
      // One grouped query per source, each on its own (robot, time) index.
      // Log entries per day: the same sources and permissions as the Logs tab (raw robot messages left out).
      const logKinds: RobotLogKind[] = [];
      for (const k of ROBOT_LOG_KINDS) {
        const need = EXTRA_PERMISSION[k];
        if (k !== 'message' && (!need || (await app.perms.can(user, need, { type: 'robot', id: params.robotId })))) logKinds.push(k);
      }
      const logUnion = logKinds.map((k) => `SELECT x.ts::timestamptz AS ts, x.level::text AS level FROM (${SOURCES[k]}) AS x(ts, kind, level, title, body, ref, actor)`).join(' UNION ALL ');
      const [rec, mis, ev, det, log] = await Promise.all([
        db.query<{ d: string; n: number; bytes: string }>(
          `SELECT ${DAY('coalesce(s.started_at, s.created_at)')} AS d, count(*)::int AS n,
                  coalesce(sum((SELECT sum(f.size_bytes) FROM archive_files f WHERE f.session_ref = s.id)), 0)::bigint AS bytes
           FROM archive_sessions s WHERE s.robot_id = $1 AND s.deleted_at IS NULL AND coalesce(s.started_at, s.created_at) >= $2 AND coalesce(s.started_at, s.created_at) < $3 GROUP BY 1`,
          range,
        ),
        db.query<{ d: string; n: number; bad: number }>(
          `SELECT ${DAY('coalesce(m.started_at, m.created_at)')} AS d, count(*)::int AS n, count(*) FILTER (WHERE m.result IN ('failed', 'aborted'))::int AS bad
           FROM missions m WHERE m.robot_id = $1 AND coalesce(m.started_at, m.created_at) >= $2 AND coalesce(m.started_at, m.created_at) < $3 GROUP BY 1`,
          range,
        ),
        db.query<{ d: string; n: number; crit: number }>(
          `SELECT ${DAY('e.ts')} AS d, count(*)::int AS n, count(*) FILTER (WHERE e.severity = 'critical')::int AS crit
           FROM events e WHERE e.robot_id = $1 AND e.ts >= $2 AND e.ts < $3 GROUP BY 1`,
          range,
        ),
        db.query<{ d: string; n: number }>(
          `SELECT ${DAY('d.detected_at')} AS d, count(*)::int AS n
           FROM detections d WHERE d.robot_id = $1 AND d.kind = 'human' AND d.status = 'confirmed' AND d.detected_at >= $2 AND d.detected_at < $3 GROUP BY 1`,
          range,
        ),
        db.query<{ d: string; n: number; warn: number }>(
          `SELECT ${DAY('l.ts')} AS d, count(*)::int AS n, count(*) FILTER (WHERE l.level IN ('warning', 'critical', 'fault', 'error'))::int AS warn
           FROM (${logUnion}) l WHERE l.ts >= $2 AND l.ts < $3 GROUP BY 1`,
          range,
        ),
      ]);
      const days = new Map<string, RobotActivityDayDto>();
      const day = (d: string) => {
        let row = days.get(d);
        if (!row) days.set(d, (row = { date: d, recordings: 0, recording_bytes: 0, missions: 0, missions_bad: 0, events: 0, events_critical: 0, detections: 0, log: 0, log_warnings: 0 }));
        return row;
      };
      for (const r of rec.rows) Object.assign(day(r.d), { recordings: r.n, recording_bytes: Number(r.bytes) });
      for (const r of mis.rows) Object.assign(day(r.d), { missions: r.n, missions_bad: r.bad });
      for (const r of ev.rows) Object.assign(day(r.d), { events: r.n, events_critical: r.crit });
      for (const r of det.rows) day(r.d).detections = r.n;
      for (const r of log.rows) Object.assign(day(r.d), { log: r.n, log_warnings: r.warn });
      return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    },
  });
}
