import type { Db, Queryable } from '../db';
import type { HealthLevel, LiveStateDto, RobotDetailDto, RobotListItemDto, RobotStatus } from '../shared';
import { notFound } from '../lib/errors';
import { iso, Where } from '../lib/sql';

/** One SELECT for list + detail. Status and mission totals are computed here, never stored (rules 8, §5). */
export const ROBOT_SELECT = `
SELECT r.robot_id, r.serial_number, r.product_id, p.code AS product_code, p.name AS product_name,
       r.hardware_revision_id, hr.name AS hardware_revision, r.running_number, r.notes,
       r.created_at, r.updated_at, r.deleted_at,
       o.company_id AS owner_company_id, c.name AS owner_company, o.valid_from AS owner_since,
       ls.last_seen_at, ls.battery_pct, ls.current_mission_id, ls.odometer_m,
       ls.health_controller, ls.health_lidar, ls.health_cameras, ls.health_gps,
       coalesce(ls.sw_ver, sw.sw_ver) AS sw_ver, coalesce(ls.fw_ver, sw.fw_ver) AS fw_ver,
       CASE WHEN ls.last_seen_at IS NULL THEN 'offline'
            WHEN now() - ls.last_seen_at <  interval '60 seconds' THEN 'online'
            WHEN now() - ls.last_seen_at <= interval '5 minutes'  THEN 'stale'
            ELSE 'offline' END AS status,
       ms.total_missions, ms.completed, ms.failed, ms.aborted, ms.in_progress,
       ms.total_distance_m, ms.total_duration_s, ms.avg_duration_s,
       ev.unacked_critical_events,
       al.last_upload_at,
       coalesce(now() - al.last_upload_at < interval '2 minutes', false) AS sending_data,
       coalesce(now() - al.last_seen_at < interval '5 minutes' AND al.last_status->'session'->>'session_id' IS NOT NULL, false) AS recording,
       arc.video_sessions
FROM robots r
JOIN products p ON p.id = r.product_id
LEFT JOIN hardware_revisions hr ON hr.id = r.hardware_revision_id
LEFT JOIN company_assignment_history o ON o.robot_id = r.robot_id AND o.valid_to IS NULL
LEFT JOIN companies c ON c.id = o.company_id
LEFT JOIN live_state ls ON ls.robot_id = r.robot_id
LEFT JOIN LATERAL (
  SELECT sw_ver, fw_ver FROM software_history WHERE robot_id = r.robot_id ORDER BY reported_at DESC LIMIT 1
) sw ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int AS total_missions,
         count(*) FILTER (WHERE result = 'completed')::int AS completed,
         count(*) FILTER (WHERE result = 'failed')::int AS failed,
         count(*) FILTER (WHERE result = 'aborted')::int AS aborted,
         count(*) FILTER (WHERE result = 'in_progress')::int AS in_progress,
         coalesce(sum(distance_m), 0)::float8 AS total_distance_m,
         coalesce(sum(duration_s), 0)::float8 AS total_duration_s,
         avg(duration_s)::float8 AS avg_duration_s
  FROM missions WHERE robot_id = r.robot_id
) ms ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int AS unacked_critical_events
  FROM events WHERE robot_id = r.robot_id AND severity = 'critical' AND acknowledged_at IS NULL
) ev ON true
LEFT JOIN archive_robot_link al ON al.robot_id = r.robot_id
LEFT JOIN LATERAL (
  SELECT count(*)::int AS video_sessions FROM archive_sessions WHERE robot_id = r.robot_id
) arc ON true`;

type RobotRow = Record<string, unknown> & {
  robot_id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  last_seen_at: Date | null;
  owner_since: Date | null;
};

export function toRobotListItem(r: RobotRow): RobotListItemDto {
  return {
    robot_id: r.robot_id,
    serial_number: r.serial_number as string,
    product_code: r.product_code as string,
    product_name: r.product_name as string,
    hardware_revision: (r.hardware_revision as string | null) ?? null,
    owner_company: (r.owner_company as string | null) ?? null,
    status: r.status as RobotStatus,
    last_seen_at: iso(r.last_seen_at),
    battery_pct: (r.battery_pct as number | null) ?? null,
    health: {
      controller: (r.health_controller as HealthLevel | null) ?? null,
      lidar: (r.health_lidar as HealthLevel | null) ?? null,
      cameras: (r.health_cameras as HealthLevel | null) ?? null,
      gps: (r.health_gps as HealthLevel | null) ?? null,
    },
    current_mission_id: (r.current_mission_id as string | null) ?? null,
    odometer_m: r.odometer_m === null || r.odometer_m === undefined ? null : Number(r.odometer_m),
    sw_ver: (r.sw_ver as string | null) ?? null,
    fw_ver: (r.fw_ver as string | null) ?? null,
    total_missions: Number(r.total_missions ?? 0),
    completed: Number(r.completed ?? 0),
    failed: Number(r.failed ?? 0),
    aborted: Number(r.aborted ?? 0),
    in_progress: Number(r.in_progress ?? 0),
    total_distance_m: Number(r.total_distance_m ?? 0),
    total_duration_s: Number(r.total_duration_s ?? 0),
    avg_duration_s: r.avg_duration_s === null || r.avg_duration_s === undefined ? null : Number(r.avg_duration_s),
    unacked_critical_events: Number(r.unacked_critical_events ?? 0),
    last_upload_at: iso(r.last_upload_at as Date | null),
    sending_data: r.sending_data === true,
    recording: r.recording === true,
    video_sessions: Number(r.video_sessions ?? 0),
    created_at: iso(r.created_at)!,
    deleted_at: iso(r.deleted_at),
  };
}

export function toRobotDetail(r: RobotRow): RobotDetailDto {
  return {
    ...toRobotListItem(r),
    product_id: r.product_id as string,
    hardware_revision_id: (r.hardware_revision_id as string | null) ?? null,
    running_number: r.running_number as number,
    notes: (r.notes as string | null) ?? null,
    updated_at: iso(r.updated_at)!,
    owner_company_id: (r.owner_company_id as string | null) ?? null,
    owner_since: iso(r.owner_since),
  };
}

export const ROBOT_SORTS: Record<string, string> = {
  robot_id: 'r.product_id, r.running_number',
  serial_number: 'r.serial_number',
  product: 'p.name, r.running_number',
  status: "CASE WHEN ls.last_seen_at IS NULL THEN 3 WHEN now() - ls.last_seen_at < interval '60 seconds' THEN 1 WHEN now() - ls.last_seen_at <= interval '5 minutes' THEN 2 ELSE 3 END",
  last_seen_at: 'ls.last_seen_at',
  battery_pct: 'ls.battery_pct',
  total_missions: 'ms.total_missions',
  total_distance_m: 'ms.total_distance_m',
  odometer_m: 'ls.odometer_m',
  total_duration_s: 'ms.total_duration_s',
  avg_duration_s: 'ms.avg_duration_s',
  unacked_critical_events: 'ev.unacked_critical_events',
  last_upload_at: 'al.last_upload_at',
  video_sessions: 'arc.video_sessions',
  created_at: 'r.created_at',
};

export class RobotsService {
  constructor(private readonly db: Db) {}

  async detail(robotId: string, db: Queryable = this.db, includeDeleted = true): Promise<RobotDetailDto> {
    const w = new Where().add('r.robot_id = ?', robotId);
    if (!includeDeleted) w.add('r.deleted_at IS NULL');
    const row = (await db.query<RobotRow>(`${ROBOT_SELECT} ${w.toSql()}`, w.params)).rows[0];
    if (!row) throw notFound(`robot ${robotId}`);
    return toRobotDetail(row);
  }

  /** Ensures the robot exists; optionally that it is not soft-deleted (writes to deleted robots are refused). */
  async assertExists(robotId: string, opts: { allowDeleted?: boolean } = {}, db: Queryable = this.db): Promise<void> {
    const row = (await db.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM robots WHERE robot_id = $1', [robotId])).rows[0];
    if (!row) throw notFound(`robot ${robotId}`);
    if (row.deleted_at && !opts.allowDeleted) throw notFound(`robot ${robotId} (deleted — restore it first)`);
  }

  async live(robotId: string): Promise<LiveStateDto> {
    const r = (
      await this.db.query<Record<string, unknown> & { last_seen_at: Date | null; state_ts: Date | null }>(
        `SELECT ls.*, s.status FROM live_state ls JOIN v_robot_status s ON s.robot_id = ls.robot_id WHERE ls.robot_id = $1`,
        [robotId],
      )
    ).rows[0];
    if (!r) throw notFound(`live state of ${robotId}`);
    const n = (k: string) => (r[k] as number | null) ?? null;
    return {
      robot_id: robotId,
      status: r.status as RobotStatus,
      last_seen_at: iso(r.last_seen_at),
      state_ts: iso(r.state_ts),
      position:
        r.lat === null || r.lon === null
          ? null
          : { lat: n('lat')!, lon: n('lon')!, alt_m: n('alt_m'), fix: (r.fix_quality as string) ?? null, hdop: n('hdop'), sats: n('sats'), heading_deg: n('heading_deg'), speed_mps: n('speed_mps') },
      battery: { pct: n('battery_pct'), voltage_v: n('battery_v'), charging: (r.charging as boolean | null) ?? null },
      signal_dbm: n('signal_dbm'),
      temps_c: { controller: n('temp_controller_c'), battery: n('temp_battery_c'), motors: (r.temp_motors_c as Record<string, number> | null) ?? null },
      armed: (r.armed as boolean | null) ?? null,
      mode: (r.mode as string | null) ?? null,
      health: {
        controller: (r.health_controller as HealthLevel | null) ?? null,
        lidar: (r.health_lidar as HealthLevel | null) ?? null,
        cameras: (r.health_cameras as HealthLevel | null) ?? null,
        gps: (r.health_gps as HealthLevel | null) ?? null,
      },
      current_mission_id: (r.current_mission_id as string | null) ?? null,
      odometer_m: n('odometer_m'),
      odometer_ts: iso(r.odometer_ts as Date | null),
    };
  }
}
