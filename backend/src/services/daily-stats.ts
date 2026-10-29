import type { Db } from '../db';
import { computeDailyDistance } from '../routes/reports';
import { istDate } from './day-report';

/** How far back a robot's first rollup goes, and how many days each later pass recomputes. */
const MAX_BACKFILL_DAYS = 400;
const RECENT_DAYS = 3;
/** Every few hours a deeper pass catches data that arrived late (archived uploads, imports). */
const DEEP_DAYS = 35;
const DEEP_EVERY_MS = 6 * 3_600_000;
const CHUNK_DAYS = 31;

const istStart = (day: string) => new Date(`${day}T00:00:00+05:30`);
const addDays = (day: string, n: number) => istDate(new Date(istStart(day).getTime() + n * 86_400_000 + 12 * 3_600_000));

/**
 * Keeps robot_daily_stats (0025) up to date: distance, time moving and time online per robot and IST day.
 * Fleet-wide reports read that table in one query, whatever the fleet size; one robot's own reports still
 * compute from its telemetry (exact, and clipped to what the user may see).
 */
export class DailyStatsService {
  private lastDeep = 0;

  constructor(private readonly db: Db) {}

  /** Recomputes [fromDay, today] for one robot. */
  async refreshRobot(robotId: string, fromDay: string): Promise<number> {
    const today = istDate(new Date());
    let n = 0;
    for (let day = fromDay; day <= today; day = addDays(day, CHUNK_DAYS)) {
      const last = addDays(day, CHUNK_DAYS - 1) < today ? addDays(day, CHUNK_DAYS - 1) : today;
      const start = istStart(day);
      const end = istStart(addDays(last, 1));
      const rows = await computeDailyDistance(this.db, robotId, [{ from: start, to: end }], start, end);
      for (const r of rows) {
        await this.db.query(
          `INSERT INTO robot_daily_stats (robot_id, day, odometer_m, wheel_m, moving_s, online_s, first_seen_at, last_seen_at, odometer_end_m, computed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (robot_id, day) DO UPDATE SET odometer_m = EXCLUDED.odometer_m, wheel_m = EXCLUDED.wheel_m, moving_s = EXCLUDED.moving_s,
             online_s = EXCLUDED.online_s, first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at,
             odometer_end_m = EXCLUDED.odometer_end_m, computed_at = now()`,
          [robotId, r.date, r.odometer_m, r.wheel_m, r.moving_s, r.online_s, r.first_seen_at, r.last_seen_at, r.odometer_end_m],
        );
        n++;
      }
    }
    return n;
  }

  /** One pass over every robot: new robots are backfilled from their first data, the rest recompute recent days. */
  async refreshAll(): Promise<{ robots: number; days: number }> {
    const deep = Date.now() - this.lastDeep > DEEP_EVERY_MS;
    const today = istDate(new Date());
    const robots = (
      await this.db.query<{ robot_id: string; last_day: string | null; first_ts: Date | null }>(
        `SELECT r.robot_id, (SELECT max(day)::text FROM robot_daily_stats s WHERE s.robot_id = r.robot_id) AS last_day,
                least((SELECT min(ts) FROM telemetry_gps g WHERE g.robot_id = r.robot_id),
                      (SELECT min(ts) FROM ingested_messages m WHERE m.robot_id = r.robot_id AND m.type = 'live')) AS first_ts
         FROM robots r WHERE r.deleted_at IS NULL ORDER BY r.robot_id`,
      )
    ).rows;
    let days = 0;
    for (const r of robots) {
      if (!r.first_ts) continue;
      const floor = addDays(today, -MAX_BACKFILL_DAYS);
      const first = istDate(r.first_ts) > floor ? istDate(r.first_ts) : floor;
      // Recent days every pass (a deep pass goes further back); after a pause, from the day before the last one computed.
      const recent = addDays(today, -(deep ? DEEP_DAYS : RECENT_DAYS));
      const resume = r.last_day ? addDays(r.last_day, -1) : first;
      const from = !r.last_day ? first : resume < recent ? resume : recent;
      days += await this.refreshRobot(r.robot_id, from > first ? from : first);
    }
    if (deep) this.lastDeep = Date.now();
    return { robots: robots.length, days };
  }
}
