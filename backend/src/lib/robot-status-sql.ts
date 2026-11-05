import { STATUS_THRESHOLDS } from '../shared/constants';

/**
 * Robot status in SQL: online if the last message came within the threshold, otherwise offline.
 * Must agree with computeRobotStatus() in shared/status.ts; both use STATUS_THRESHOLDS.
 */
export const robotStatusCase = (lastSeen = 'ls.last_seen_at') =>
  `CASE WHEN ${lastSeen} IS NOT NULL AND now() - ${lastSeen} <= interval '${STATUS_THRESHOLDS.onlineMs / 1000} seconds' THEN 'online' ELSE 'offline' END`;

/**
 * Every robot with its status, for joining in queries: (robot_id, last_seen_at, status).
 * Used instead of the older database view v_robot_status, which still has the previous rule.
 */
export const ROBOT_STATUS_SQL = `(SELECT r.robot_id, ls.last_seen_at, ${robotStatusCase()} AS status FROM robots r LEFT JOIN live_state ls ON ls.robot_id = r.robot_id)`;
