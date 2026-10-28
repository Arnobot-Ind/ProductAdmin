/**
 * Patrol / night-surveillance report figures for one robot and one IST window, in the layout of the GCS's
 * hand-made "Night Surveillance Report" (GCS frontend features/logs/report.ts), but computed from what the robot
 * sends the portal on its own: 1 Hz GPS samples with wheel speed (telemetry_gps) and the 30 s live status with
 * the lifetime odometer and satellite count (ingested_messages, type 'live'). Pure functions; the route loads.
 *
 * Person detections are not here: the robot keeps them on board and never sends them to the portal.
 */
import type { DayReportDto, ReportHourDto, ReportPathPointDto, TimeSpanDto } from '../shared';

export const IST_OFFSET_MS = 5.5 * 3600_000;
export const MOVING_MPS = 0.05; // counted as moving (as the GCS Logs tab)
export const PATROL_MPS = 0.2; // "patrolling" in the activity bar
const MAX_STEP_S = 10; // wheel-speed integration skips longer silences
const GAP_MS = 90_000; // no data for longer = offline (live status comes every 30 s)
const LEG_JOIN_MS = 30_000;
const MAX_PLAUSIBLE_MPS = 6; // faster than the robot can drive
const MAX_PATH_POINTS = 4000;

/** GNSS fixes the map trusts as measured; anything else positioned (e.g. 'stale') is an estimate; 'none' is no fix. */
export const GOOD_FIXES = new Set(['2d', '3d', 'dgps', 'rtk_float', 'rtk_fixed', 'single', 'pps', 'rtk_fix']);

export interface GpsSample {
  ts: Date;
  lat: number | null;
  lon: number | null;
  speed: number | null;
  fix: string | null;
}
export interface LiveSample {
  ts: Date;
  odometer_m: number | null;
  sats: number | null;
  fix: string | null;
  battery_pct: number | null;
}
export interface BatterySample {
  ts: Date;
  pct: number | null;
}

// ── IST helpers ─────────────────────────────────────────────────────────────
/** 'YYYY-MM-DD' + 'HH:MM' (IST; '24:00' = end of day) → instant. */
export function istInstant(date: string, hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const midnight = Date.parse(`${date}T00:00:00+05:30`);
  return new Date(midnight + (h * 60 + m) * 60_000);
}
/** IST calendar day of an instant. */
export const istDate = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
/** Window for a report: `to` at or before `from` means the window runs past midnight (22:00–06:00). */
export function reportWindow(date: string, from = '00:00', to = '24:00'): { start: Date; end: Date } {
  const start = istInstant(date, from);
  let end = istInstant(date, to);
  if (end <= start) end = new Date(end.getTime() + 86_400_000);
  return { start, end };
}

const haversineM = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const r = 6371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
};

// ── path cleaning (port of GCS features/logs/path.ts cleanPath) ─────────────
const positioned = (g: GpsSample) => g.lat !== null && g.lon !== null && (g.lat !== 0 || g.lon !== 0) && g.fix !== 'none';
const isGood = (g: GpsSample) => g.fix === null || GOOD_FIXES.has(g.fix.toLowerCase());
const mps = (a: GpsSample, b: GpsSample) => haversineM(a.lat!, a.lon!, b.lat!, b.lon!) / Math.max(1, (b.ts.getTime() - a.ts.getTime()) / 1000);

/**
 * Which positions are drawn: measured fixes minus lone spikes; estimated positions only while physically
 * reachable, none after an impossible jump until the next measured fix, and a measured fix that contradicts the
 * estimated points just before it removes that drifted tail.
 */
export function cleanPath(samples: GpsSample[]): GpsSample[] {
  const kept: GpsSample[] = [];
  let tainted = false;
  let prev: GpsSample | null = null;
  for (const r of samples) {
    if (!positioned(r)) continue;
    const jump = prev !== null && mps(prev, r) > MAX_PLAUSIBLE_MPS;
    prev = r;
    if (isGood(r)) {
      tainted = false;
      while (kept.length && !isGood(kept[kept.length - 1]) && mps(kept[kept.length - 1], r) > MAX_PLAUSIBLE_MPS) kept.pop();
      kept.push(r);
    } else {
      if (jump) tainted = true;
      if (!tainted && (!kept.length || mps(kept[kept.length - 1], r) <= MAX_PLAUSIBLE_MPS)) kept.push(r);
    }
  }
  return kept.filter((p, i) => {
    if (i === 0 || i === kept.length - 1) return true;
    const a = kept[i - 1];
    const c = kept[i + 1];
    return !(mps(a, p) > MAX_PLAUSIBLE_MPS && mps(p, c) > MAX_PLAUSIBLE_MPS && mps(a, c) <= MAX_PLAUSIBLE_MPS);
  });
}

/** Thins a long track to at most `max` points, always keeping both ends of every break (gap > 30 s). */
function thin(path: GpsSample[], max: number): GpsSample[] {
  if (path.length <= max) return path;
  const step = path.length / max;
  const keep = new Set<number>([0, path.length - 1]);
  for (let i = 0; i < max; i++) keep.add(Math.floor(i * step));
  for (let i = 1; i < path.length; i++) {
    if (path[i].ts.getTime() - path[i - 1].ts.getTime() > LEG_JOIN_MS) keep.add(i - 1).add(i);
  }
  return [...keep].sort((a, b) => a - b).map((i) => path[i]);
}

/** Wheel distance and moving time over consecutive samples whose LATER sample lies in [from, to). */
function wheel(gps: GpsSample[], from = -Infinity, to = Infinity): { distance: number; moving: number } {
  let distance = 0;
  let moving = 0;
  for (let i = 1; i < gps.length; i++) {
    const t = gps[i].ts.getTime();
    if (t < from || t >= to) continue;
    const dt = (t - gps[i - 1].ts.getTime()) / 1000;
    const sp = gps[i].speed ?? 0;
    if (sp > MOVING_MPS && dt > 0 && dt <= MAX_STEP_S) {
      distance += sp * dt;
      moving += dt;
    }
  }
  return { distance, moving };
}

/** Odometer increase over live samples whose later sample lies in [from, to); resets and impossible jumps skipped. */
function odometer(live: LiveSample[], from = -Infinity, to = Infinity): number | null {
  const odo = live.filter((l) => l.odometer_m !== null);
  if (odo.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < odo.length; i++) {
    const t = odo[i].ts.getTime();
    if (t < from || t >= to) continue;
    const d = odo[i].odometer_m! - odo[i - 1].odometer_m!;
    const dt = (t - odo[i - 1].ts.getTime()) / 1000;
    if (d > 0 && d <= Math.max(dt, 1) * MAX_PLAUSIBLE_MPS) sum += d;
  }
  return sum;
}

const span = (a: number, b: number): TimeSpanDto => ({ from: new Date(a).toISOString(), to: new Date(b).toISOString() });

export interface DayReportInput {
  robot: { robot_id: string; robot_name: string; product_name: string; owner_company: string | null };
  date: string;
  start: Date;
  end: Date;
  clipped: boolean;
  gps: GpsSample[];
  live: LiveSample[];
  battery: BatterySample[];
  missions: DayReportDto['missions'];
}

export function computeDayReport(inp: DayReportInput): DayReportDto {
  const startMs = inp.start.getTime();
  const endMs = inp.end.getTime();
  const gps = [...inp.gps].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const live = [...inp.live].sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // Online: any message from the robot (GPS samples or live status) in that minute.
  const stamps = [...gps.map((g) => g.ts.getTime()), ...live.map((l) => l.ts.getTime())].filter((t) => t >= startMs && t < endMs).sort((a, b) => a - b);
  const minuteOf = (t: number) => Math.floor((t - startMs) / 60_000);
  const minutes = Math.max(1, Math.ceil((endMs - startMs) / 60_000));
  const activity = new Array<number>(minutes).fill(0);
  for (const t of stamps) activity[minuteOf(t)] = Math.max(activity[minuteOf(t)], 1);
  for (const g of gps) {
    const i = minuteOf(g.ts.getTime());
    if (i >= 0 && i < minutes && (g.speed ?? 0) > PATROL_MPS) activity[i] = 2;
  }
  const onlineMin = activity.filter((a) => a > 0).length;

  // Continuous coverage and offline gaps (also at the edges of the window).
  const runs: [number, number][] = [];
  for (const t of stamps) {
    const last = runs[runs.length - 1];
    if (last && t - last[1] <= GAP_MS) last[1] = t;
    else runs.push([t, t]);
  }
  const gaps: [number, number][] = runs.slice(1).map((r, i) => [runs[i][1], r[0]]);
  if (!runs.length) gaps.push([startMs, endMs]);
  else {
    if (runs[0][0] - startMs > GAP_MS) gaps.unshift([startMs, runs[0][0]]);
    if (endMs - runs[runs.length - 1][1] > GAP_MS) gaps.push([runs[runs.length - 1][1], endMs]);
  }
  const longest = runs.reduce<[number, number] | null>((a, b) => (!a || b[1] - b[0] > a[1] - a[0] ? b : a), null);

  // Moving legs (> 0.2 m/s, joined across < 30 s), the two longest of at least 2 min.
  const legs: [number, number][] = [];
  for (const g of gps) {
    if ((g.speed ?? 0) <= PATROL_MPS) continue;
    const t = g.ts.getTime();
    const last = legs[legs.length - 1];
    if (last && t - last[1] < LEG_JOIN_MS) last[1] = t;
    else legs.push([t, t]);
  }
  const topLegs = [...legs]
    .sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
    .slice(0, 2)
    .filter((l) => l[1] - l[0] >= 120_000)
    .sort((a, b) => a[0] - b[0]);

  const w = wheel(gps);
  const odo = odometer(live);
  const distance = odo ?? w.distance;
  const peak = gps.length ? Math.max(...gps.map((g) => g.speed ?? 0)) : null;

  // Hour by hour, on IST hour boundaries.
  const hours: ReportHourDto[] = [];
  const firstHour = Math.floor((startMs + IST_OFFSET_MS) / 3600_000) * 3600_000 - IST_OFFSET_MS;
  for (let h = firstHour; h < endMs; h += 3600_000) {
    const a = Math.max(h, startMs);
    const b = Math.min(h + 3600_000, endMs);
    const hw = wheel(gps, a, b);
    const ho = odo !== null ? odometer(live, a, b) : null;
    hours.push({
      from: new Date(a).toISOString(),
      // Person detections do not reach the portal yet (the robot keeps them on board).
      events: 0,
      to: new Date(b).toISOString(),
      online_min: activity.filter((x, i) => x > 0 && startMs + i * 60_000 >= a && startMs + i * 60_000 < b).length,
      moving_s: Math.round(hw.moving),
      distance_m: Math.round(ho ?? hw.distance),
    });
  }

  // GPS quality and satellites (sats come with the live status).
  const pos = gps.filter(positioned);
  const good = pos.filter(isGood);
  const sats = live
    .filter((l) => l.sats !== null && l.sats > 0 && (l.fix === null || GOOD_FIXES.has(l.fix.toLowerCase())))
    .map((l) => l.sats!)
    .sort((a, b) => a - b);

  // Battery telemetry when there is any, otherwise the live status.
  const fromTelemetry = inp.battery.filter((b) => b.pct !== null).map((b) => ({ ts: b.ts.getTime(), pct: b.pct! }));
  const bat = (fromTelemetry.length ? fromTelemetry : live.filter((l) => l.battery_pct !== null).map((l) => ({ ts: l.ts.getTime(), pct: l.battery_pct! }))).sort((a, b) => a.ts - b.ts);

  const clean = cleanPath(gps);
  const path: ReportPathPointDto[] = thin(clean, MAX_PATH_POINTS).map((g) => ({ t: g.ts.toISOString(), lat: g.lat!, lon: g.lon!, est: !isGood(g) }));
  const startHourIst = new Date(startMs + IST_OFFSET_MS).getUTCHours();
  const endHourIst = new Date(endMs - 1 + IST_OFFSET_MS).getUTCHours();

  return {
    ...inp.robot,
    date: inp.date,
    from: inp.start.toISOString(),
    to: inp.end.toISOString(),
    night: startHourIst >= 18 || endHourIst < 6,
    clipped: inp.clipped,
    // Site label for now: the missions run in the window (user decision, 2026-10-10).
    site: [...new Set(inp.missions.map((m) => m.name).filter((n): n is string => !!n))].join(', ') || null,
    detection: { available: false, enabled_spans: [], events: 0, persons: 0, by_camera: [], log: [], evidence: [] },
    summary: {
      distance_m: Math.round(distance),
      distance_source: odo !== null ? 'odometer' : gps.length ? 'wheel_speed' : 'none',
      online_s: onlineMin * 60,
      moving_s: Math.round(w.moving),
      peak_mps: peak,
      avg_moving_mps: w.moving ? w.distance / w.moving : null,
      gps_reliable_pct: pos.length ? Math.round((good.length / pos.length) * 100) : null,
      median_sats: sats.length ? sats[Math.floor(sats.length / 2)] : null,
      battery_start_pct: bat.length ? bat[0].pct : null,
      battery_end_pct: bat.length ? bat[bat.length - 1].pct : null,
      battery_min_pct: bat.length ? Math.min(...bat.map((b) => b.pct)) : null,
    },
    hours,
    activity,
    path,
    path_hidden: pos.length - clean.length,
    longest_online: longest ? span(longest[0], longest[1]) : null,
    offline_gaps: gaps.map(([a, b]) => span(a, b)),
    longest_legs: topLegs.map(([a, b]) => span(a, b)),
    missions: inp.missions,
  };
}
