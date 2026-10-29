import { CLIENT_FEATURES, ROBOT_CATEGORIES, type CategorySummaryDto, type DashboardDto, type RobotCategory, type RobotStatus } from '../shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { anyScope, route } from '../lib/route';
import { iso, Where } from '../lib/sql';
import { activeFaults, EVENT_SELECT, toEvent } from './events';

/** Fleet overview. Every figure is limited to robots the user may read. */
export function dashboardRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  route(f, app, {
    method: 'GET',
    path: '/dashboard',
    summary: 'Fleet overview: status counts, alerts, faults, recent missions and events',
    tag: 'Dashboard',
    access: { can: 'robot.read', target: anyScope() },
    handler: async ({ user }): Promise<DashboardDto> => {
      const scope = app.perms.robotScope(user, 'robot.read');
      // Missions, events, messages and warranty are Arnobot-internal (robot.details): customers get none of them.
      const detailScope = app.perms.robotScope(user, 'robot.details');
      const scoped = (col: string, extra?: (w: Where) => void) => {
        const w = new Where();
        app.perms.applyRobotScope(w, scope, col);
        extra?.(w);
        return w;
      };
      // Records (missions, events, messages): never those made while another customer owned the robot.
      const scopedData = (col: string, time: string, extra?: (w: Where) => void) => {
        const w = new Where();
        app.perms.applyDataScope(w, detailScope, col, time);
        extra?.(w);
        return w;
      };

      const rw = scoped('r.robot_id', (w) => w.add('r.deleted_at IS NULL'));
      const robots = await db.query<{
        robot_id: string;
        status: RobotStatus;
        faults: string[] | null;
        warranty_end: string | null;
        product_name: string;
        category: RobotCategory;
        lat: number | null;
        lon: number | null;
        battery_pct: number | null;
        last_seen_at: Date | null;
      }>(
        `SELECT r.robot_id, s.status, p.name AS product_name, p.category, ls.lat, ls.lon, ls.battery_pct, ls.last_seen_at,
                array_remove(ARRAY[
                  CASE WHEN ls.health_controller = 'fault' THEN 'controller' END,
                  CASE WHEN ls.health_lidar = 'fault' THEN 'lidar' END,
                  CASE WHEN ls.health_cameras = 'fault' THEN 'cameras' END,
                  CASE WHEN ls.health_gps = 'fault' THEN 'gps' END], NULL) AS faults,
                CASE WHEN dw.warranty_end BETWEEN current_date AND current_date + 30 THEN dw.warranty_end END AS warranty_end
         FROM robots r JOIN v_robot_status s ON s.robot_id = r.robot_id
         JOIN products p ON p.id = r.product_id
         LEFT JOIN live_state ls ON ls.robot_id = r.robot_id
         LEFT JOIN dispatch_warranty dw ON dw.robot_id = r.robot_id
         ${rw.toSql()} ORDER BY r.robot_id`,
        rw.params,
      );
      const byStatus: Record<RobotStatus, number> = { online: 0, stale: 0, offline: 0 };
      for (const r of robots.rows) byStatus[r.status]++;

      const ew = scopedData('e.robot_id', 'e.ts', (w) => w.add('e.acknowledged_at IS NULL').add('EXISTS (SELECT 1 FROM robots rr WHERE rr.robot_id = e.robot_id AND rr.deleted_at IS NULL)'));
      const unacked = (
        await db.query<{ total: number; critical: number; warning: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE e.severity = 'critical')::int AS critical,
                  count(*) FILTER (WHERE e.severity = 'warning')::int AS warning FROM events e ${ew.toSql()}`,
          ew.params,
        )
      ).rows[0];

      const mw = scopedData('m.robot_id', 'coalesce(m.started_at, m.created_at)', (w) => w.add("coalesce(m.started_at, m.created_at) > now() - interval '7 days'"));
      const m7 = (
        await db.query(
          `SELECT count(*) FILTER (WHERE result = 'completed')::int AS completed, count(*) FILTER (WHERE result = 'failed')::int AS failed,
                  count(*) FILTER (WHERE result = 'aborted')::int AS aborted, count(*) FILTER (WHERE result = 'in_progress')::int AS in_progress
           FROM missions m ${mw.toSql()}`,
          mw.params,
        )
      ).rows[0];

      // All missions ever, by result, and per category (with distance and time on missions).
      const aw = scopedData('m.robot_id', 'coalesce(m.started_at, m.created_at)');
      const perCategory = (
        await db.query<{ category: RobotCategory; total: number; completed: number; failed: number; aborted: number; in_progress: number; distance_m: number; duration_s: number }>(
          `SELECT p.category, count(*)::int AS total,
                  count(*) FILTER (WHERE m.result = 'completed')::int AS completed, count(*) FILTER (WHERE m.result = 'failed')::int AS failed,
                  count(*) FILTER (WHERE m.result = 'aborted')::int AS aborted, count(*) FILTER (WHERE m.result = 'in_progress')::int AS in_progress,
                  coalesce(sum(m.distance_m), 0)::float8 AS distance_m, coalesce(sum(m.duration_s), 0)::float8 AS duration_s
           FROM missions m JOIN robots r ON r.robot_id = m.robot_id AND r.deleted_at IS NULL JOIN products p ON p.id = r.product_id
           ${aw.toSql()} GROUP BY p.category`,
          aw.params,
        )
      ).rows;

      const faults = await activeFaults(db, scopedData('e.robot_id', 'e.ts'));
      const cew = scopedData('e.robot_id', 'e.ts', (w) =>
        w.add("e.severity = 'critical'").add('e.acknowledged_at IS NULL').add('EXISTS (SELECT 1 FROM robots rr WHERE rr.robot_id = e.robot_id AND rr.deleted_at IS NULL)'),
      );
      const criticalEvents = await db.query(`${EVENT_SELECT} ${cew.toSql()} ORDER BY e.ts DESC LIMIT 20`, cew.params);
      const gw = scopedData('e.robot_id', 'e.ts', (w) =>
        w.add("e.severity = 'critical'").add('e.acknowledged_at IS NULL').add('EXISTS (SELECT 1 FROM robots rr WHERE rr.robot_id = e.robot_id AND rr.deleted_at IS NULL)'),
      );
      const groupRows = (
        await db.query(
          `SELECT g.n, ev.* FROM (
             SELECT DISTINCT ON (e.robot_id, coalesce(e.code, e.message)) e.id, count(*) OVER (PARTITION BY e.robot_id, coalesce(e.code, e.message))::int AS n
             FROM events e ${gw.toSql()} ORDER BY e.robot_id, coalesce(e.code, e.message), e.ts DESC
           ) g JOIN (${EVENT_SELECT}) ev ON ev.id = g.id ORDER BY ev.ts DESC LIMIT 20`,
          gw.params,
        )
      ).rows;

      const faulty = new Set([...robots.rows.filter((r) => r.faults?.length).map((r) => r.robot_id), ...faults.filter((x) => x.severity === 'critical').map((x) => x.robot_id)]);
      const byCategory = Object.fromEntries(
        ROBOT_CATEGORIES.map((c): [RobotCategory, CategorySummaryDto] => {
          const rs = robots.rows.filter((r) => r.category === c);
          const m = perCategory.find((x) => x.category === c);
          return [
            c,
            {
              robots: rs.length,
              by_status: { online: rs.filter((r) => r.status === 'online').length, stale: rs.filter((r) => r.status === 'stale').length, offline: rs.filter((r) => r.status === 'offline').length },
              with_faults: rs.filter((r) => faulty.has(r.robot_id)).length,
              missions: { total: m?.total ?? 0, completed: m?.completed ?? 0, aborted: m?.aborted ?? 0, failed: m?.failed ?? 0, in_progress: m?.in_progress ?? 0 },
              mission_distance_m: m?.distance_m ?? 0,
              mission_duration_s: m?.duration_s ?? 0,
            },
          ];
        }),
      ) as Record<RobotCategory, CategorySummaryDto>;
      const sum = (k: 'completed' | 'failed' | 'aborted' | 'in_progress') => perCategory.reduce((n, x) => n + x[k], 0);

      const rmw = scopedData('m.robot_id', 'coalesce(m.started_at, m.created_at)');
      const recentMissions = await db.query(
        `SELECT m.mission_id, m.robot_id, m.name, m.started_at, m.ended_at, m.duration_s, m.distance_m, m.distance_planned_m,
                m.waypoints_total, m.waypoints_reached, m.result, m.end_reason,
                (SELECT count(*)::int FROM mission_files mf WHERE mf.mission_id = m.mission_id) AS file_count, (m.gcs_report IS NOT NULL) AS has_gcs_report
         FROM missions m ${rmw.toSql()} ORDER BY m.started_at DESC NULLS LAST, m.created_at DESC LIMIT 5`,
        rmw.params,
      );
      const rew = scopedData('e.robot_id', 'e.ts');
      const recentEvents = await db.query(`${EVENT_SELECT} ${rew.toSql()} ORDER BY e.ts DESC LIMIT 8`, rew.params);
      const imw = scopedData('i.robot_id', 'i.received_at', (w) => w.add("i.received_at > now() - interval '24 hours'"));
      const msgs = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ingested_messages i ${imw.toSql()}`, imw.params)).rows[0].n;

      // Customer users see robot positions only with the location feature (0021).
      const hideLocation = !!user.client && !user.client.features.has(CLIENT_FEATURES.robotsLocation);
      return {
        generated_at: new Date().toISOString(),
        robots_total: robots.rows.length,
        by_status: byStatus,
        by_category: byCategory,
        unacked_critical_events: unacked.critical,
        unacked_warning_events: unacked.warning,
        active_faults: faults,
        critical_events: criticalEvents.rows.map(toEvent),
        critical_event_groups: groupRows.map((r) => {
          const { n, ...e } = r;
          const latest = toEvent(e);
          return { robot_id: latest.robot_id, code: latest.code, count: n as number, latest };
        }),
        missions_total: { completed: sum('completed'), failed: sum('failed'), aborted: sum('aborted'), in_progress: sum('in_progress') },
        unacked_events: unacked.total,
        robots_with_fault: robots.rows.filter((r) => r.faults?.length).map((r) => ({ robot_id: r.robot_id, devices: r.faults! })),
        missions_last_7d: m7 as DashboardDto['missions_last_7d'],
        recent_missions: recentMissions.rows.map((r) => ({ ...r, started_at: iso(r.started_at), ended_at: iso(r.ended_at) })),
        recent_events: recentEvents.rows.map(toEvent),
        messages_last_24h: msgs,
        warranty_expiring: robots.rows.filter((r) => r.warranty_end && app.perms.holdsAnywhere(user, 'robot.details')).map((r) => ({ robot_id: r.robot_id, warranty_end: r.warranty_end! })),
        fleet: robots.rows.map((r) => ({
          robot_id: r.robot_id,
          product_name: r.product_name,
          category: r.category,
          status: r.status,
          lat: hideLocation ? null : r.lat,
          lon: hideLocation ? null : r.lon,
          battery_pct: r.battery_pct,
          last_seen_at: iso(r.last_seen_at),
          faults: r.faults ?? [],
        })),
      };
    },
  });
}
