import { describe, expect, it } from 'vitest';
import { cleanPath, computeDayReport, istDate, reportWindow, type GpsSample, type LiveSample } from './day-report';

const robot = { robot_id: 'saibya02', robot_name: 'SAIBYA02', product_name: 'Saibya', owner_company: 'Adani' };
const at = (iso: string, s = 0) => new Date(Date.parse(iso) + s * 1000);

/** One sample a second from `start` for `secs` seconds, driving north at `speed` m/s (≈ 1 m per 0.000009° lat). */
function drive(start: string, secs: number, speed: number, fix = 'rtk_fixed'): GpsSample[] {
  return Array.from({ length: secs }, (_, i) => ({ ts: at(start, i), lat: 26.86 + i * speed * 0.000009, lon: 71.51, speed, fix }));
}

describe('reportWindow', () => {
  it('reads IST wall time and runs past midnight when to <= from', () => {
    const w = reportWindow('2026-10-04', '22:00', '06:00');
    expect(w.start.toISOString()).toBe('2026-10-04T16:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-05T00:30:00.000Z');
    expect(reportWindow('2026-10-04', '22:00', '24:00').end.toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(istDate(new Date('2026-10-04T19:00:00Z'))).toBe('2026-10-05');
  });
});

describe('computeDayReport', () => {
  const { start, end } = reportWindow('2026-10-04', '22:00', '24:00');
  const base = { robot, date: '2026-10-04', start, end, clipped: false, battery: [], missions: [] };

  it('integrates wheel speed, finds legs, online minutes and gaps', () => {
    // 22:10–22:20 driving at 2 m/s, then parked 22:20–22:30, then silent.
    const gps = [...drive('2026-10-04T16:40:00Z', 600, 2), ...drive('2026-10-04T16:50:00Z', 600, 0)];
    const r = computeDayReport({ ...base, gps, live: [] });
    expect(r.night).toBe(true);
    expect(r.summary.distance_source).toBe('wheel_speed');
    expect(r.summary.distance_m).toBeCloseTo(1198, -1);
    expect(r.summary.moving_s).toBe(599);
    expect(r.summary.online_s).toBe(20 * 60);
    expect(r.activity).toHaveLength(120);
    expect(r.activity.slice(10, 20).every((a) => a === 2)).toBe(true);
    expect(r.activity.slice(20, 30).every((a) => a === 1)).toBe(true);
    expect(r.activity[0]).toBe(0);
    expect(r.longest_legs).toHaveLength(1);
    expect(r.offline_gaps.map((g) => g.from.slice(11, 16))).toEqual(['16:30', '16:59']);
    expect(r.hours.map((h) => h.online_min)).toEqual([20, 0]);
    expect(r.summary.gps_reliable_pct).toBe(100);
  });

  it('prefers the odometer and skips resets and impossible jumps', () => {
    const live: LiveSample[] = [0, 30, 60, 90, 120].map((s, i) => ({
      ts: at('2026-10-04T16:40:00Z', s),
      odometer_m: [1000, 1050, 20, 70, 99999][i],
      sats: 28,
      fix: 'rtk_fixed',
      battery_pct: 90 - i,
    }));
    const r = computeDayReport({ ...base, gps: [], live });
    expect(r.summary.distance_source).toBe('odometer');
    expect(r.summary.distance_m).toBe(100); // +50, reset skipped, +50, jump skipped
    expect(r.summary.median_sats).toBe(28);
    expect([r.summary.battery_start_pct, r.summary.battery_end_pct, r.summary.battery_min_pct]).toEqual([90, 86, 86]);
  });

  it('reports a window with no data as all offline', () => {
    const r = computeDayReport({ ...base, gps: [], live: [] });
    expect(r.summary.distance_source).toBe('none');
    expect(r.offline_gaps).toHaveLength(1);
    expect(r.path).toEqual([]);
    expect(r.longest_online).toBeNull();
  });
});

describe('cleanPath', () => {
  it('drops lone spikes and no-fix rows, and stale points after an impossible jump', () => {
    const ok = drive('2026-10-04T16:40:00Z', 5, 1);
    const spike = { ...ok[2], lat: ok[2].lat! + 0.05 };
    const noFix = { ...ok[3], fix: 'none' };
    expect(cleanPath([ok[0], ok[1], spike, ok[3], ok[4]])).toHaveLength(4);
    expect(cleanPath([ok[0], noFix])).toHaveLength(1);
    const jumped = { ...ok[1], lat: ok[1].lat! + 0.05, fix: 'stale' };
    const drifting = { ...ok[2], lat: ok[2].lat! + 0.05, fix: 'stale' };
    expect(cleanPath([ok[0], jumped, drifting, ok[4]])).toEqual([ok[0], ok[4]]);
  });
});
