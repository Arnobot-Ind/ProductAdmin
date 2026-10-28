import { STATUS_THRESHOLDS, type RobotStatus } from './constants';

/**
 * Spec §7: status is computed from last-seen time, never stored.
 * Online < 60 s · Stale 60 s – 5 min · Offline > 5 min (or never seen).
 * The SQL twin of this function is the `v_robot_status` view; both must agree.
 */
export function computeRobotStatus(lastSeenAt: string | Date | null | undefined, now: Date = new Date()): RobotStatus {
  if (!lastSeenAt) return 'offline';
  const seen = typeof lastSeenAt === 'string' ? Date.parse(lastSeenAt) : lastSeenAt.getTime();
  if (Number.isNaN(seen)) return 'offline';
  const age = now.getTime() - seen;
  if (age < STATUS_THRESHOLDS.onlineMs) return 'online';
  if (age <= STATUS_THRESHOLDS.staleMs) return 'stale';
  return 'offline';
}
