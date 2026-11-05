import { STATUS_THRESHOLDS, type RobotStatus } from './constants';

/**
 * Spec §7: status is computed from last-seen time, never stored.
 * Online: a message within the last 30 s. Offline: nothing for longer, or never seen.
 * The SQL twin of this function is in the backend's lib/robot-status-sql.ts; both must agree.
 */
export function computeRobotStatus(lastSeenAt: string | Date | null | undefined, now: Date = new Date()): RobotStatus {
  if (!lastSeenAt) return 'offline';
  const seen = typeof lastSeenAt === 'string' ? Date.parse(lastSeenAt) : lastSeenAt.getTime();
  if (Number.isNaN(seen)) return 'offline';
  return now.getTime() - seen <= STATUS_THRESHOLDS.onlineMs ? 'online' : 'offline';
}
