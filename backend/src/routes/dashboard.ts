import type { DashboardDto, RobotStatus } from '../shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { anyScope, route } from '../lib/route';
import { iso, Where } from '../lib/sql';
import { EVENT_SELECT, toEvent } from './events';

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
      const scoped = (col: string, extra?: (w: Where) => void) => {
        const w = new Where();
        app.perms.applyRobotScope(w, scope, col);
        extra?.(w);
        return w;
      };
      // Records (missions, events, messages): never those made while another customer owned the robot.
      const scopedData = (col: string, time: string, extra?: (w: Where) => void) => {
        const w = new Where();
        app.perms.applyDataScope(w, scope, col, time);
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
        lat: number | null;
        lon: number | null;
        battery_pct: number | null;
        last_seen_at: Date | null;
      }>(
        `SELECT r.robot_id, s.status, p.name AS product_name, ls.lat, ls.lon, ls.battery_pct, ls.last_seen_at,
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
      const by_status: Record<RobotStatus, number> = { online: 0, stale: 0, offline: 0 };
      for (const r of robots.rows) by_status[r.status]++;

      const ew = scopedData('e.robot_id', 'e.ts', (w) => w.add('e.acknowledged_at IS NULL').add('EXISTS (SELECT 1 FROM robots rr WHERE rr.robot_id = e.robot_id AND rr.deleted_at IS NULL)'));
      const unacked = (
        await db.query<{ total: number; critical: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE e.severity = 'critical')::int AS critical FROM events e ${ew.toSql()}`,
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

      return {
        robots_total: robots.rows.length,
        by_status,
        unacked_critical_events: unacked.critical,
        unacked_events: unacked.total,
        robots_with_fault: robots.rows.filter((r) => r.faults?.length).map((r) => ({ robot_id: r.robot_id, devices: r.faults! })),
        missions_last_7d: m7 as DashboardDto['missions_last_7d'],
        recent_missions: recentMissions.rows.map((r) => ({ ...r, started_at: iso(r.started_at), ended_at: iso(r.ended_at) })),
        recent_events: recentEvents.rows.map(toEvent),
        messages_last_24h: msgs,
        warranty_expiring: robots.rows.filter((r) => r.warranty_end).map((r) => ({ robot_id: r.robot_id, warranty_end: r.warranty_end! })),
        fleet: robots.rows.map((r) => ({
          robot_id: r.robot_id,
          product_name: r.product_name,
          status: r.status,
          lat: r.lat,
          lon: r.lon,
          battery_pct: r.battery_pct,
          last_seen_at: iso(r.last_seen_at),
          faults: r.faults ?? [],
        })),
      };
    },
  });
}
