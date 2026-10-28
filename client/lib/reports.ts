'use client';

/**
 * Mission report PDFs, laid out exactly as the GCS's (gcs_frontend features/reports/reports.ts: downloadReport and
 * buildSummaryDoc) with the shared chrome in ./pdf-chrome. The only addition is the robot line under the title,
 * because a customer can own several robots.
 *
 *   missionReportPdf    one mission run          "Mission Report - <name> (ARNOBOT).pdf"
 *   summaryPdf          daily / monthly summary   "Daily Mission Summary - <date> (ARNOBOT).pdf"
 */
import type { ClientMissionDto, ClientMissionReportDto, MissionWaypointDto } from '@arnobot/message-schema';
import {
  bandTop,
  type Col,
  footers,
  GREEN,
  AMBER,
  newCtx,
  pdfClock,
  pdfDate,
  pdfDist,
  pdfDuration,
  pdfTime,
  RED,
  type Rgb,
  safeFile,
  sectionBar,
  statGrid,
  statusBadge,
  table,
  titleBlock,
} from './pdf-chrome';

export interface ReportRobot {
  robot_id: string;
  product_name: string;
  serial_number: string;
  owner_company?: string | null;
}

const robotLine = (r: ReportRobot) => `Robot ${r.robot_id.toUpperCase()} · ${r.product_name} · SN ${r.serial_number}${r.owner_company ? ` · ${r.owner_company}` : ''}`;
const statusText = (r: string) => (r === 'in_progress' ? 'in progress' : r);
const statusColor = (r: string): Rgb => (r === 'completed' ? GREEN : r === 'in_progress' ? AMBER : RED);

// ── 1. Mission Report ───────────────────────────────────────────────────────
export async function missionReportPdf(report: ClientMissionReportDto, robot: ReportRobot): Promise<void> {
  const ctx = await newCtx();
  const name = report.name || 'Mission';
  const waypoints = report.waypoints ?? [];
  bandTop(ctx);
  titleBlock(ctx, 'Mission Report', name, `Report ID: ${report.mission_id}  ·  ${robotLine(robot)}`);
  statusBadge(ctx, report.result);
  statGrid(ctx, [
    { label: 'Date', value: pdfDate(report.started_at) },
    { label: 'Started', value: pdfTime(report.started_at) },
    { label: 'Ended', value: pdfTime(report.ended_at) },
    { label: 'Duration', value: pdfDuration(report.duration_s) },
    { label: 'Distance covered', value: pdfDist(report.distance_m) },
    { label: 'Distance planned', value: pdfDist(report.distance_planned_m) },
    { label: 'Waypoints reached', value: `${report.waypoints_reached ?? 0} / ${report.waypoints_total ?? waypoints.length}` },
  ]);
  ctx.y += 6;
  sectionBar(ctx, `Waypoints (${waypoints.length})`);
  table<MissionWaypointDto>(
    ctx,
    [
      { label: '#', w: 30, value: (w) => String(w.sequence) },
      { label: 'Label', w: 95, value: (w) => w.label || '—' },
      { label: 'Lat', w: 85, value: (w) => (Number.isFinite(w.lat) ? w.lat.toFixed(6) : '—') },
      { label: 'Lng', w: 85, value: (w) => (Number.isFinite(w.lng) ? w.lng.toFixed(6) : '—') },
      { label: 'Reached', w: 70, value: (w) => (w.reached ? 'Yes' : 'No'), color: (w) => (w.reached ? GREEN : RED) },
      { label: 'Reached at', w: 150, value: (w) => (w.reached ? pdfClock(w.reached_at) : '—') },
    ],
    waypoints,
    'No waypoints recorded for this mission.',
  );
  footers(ctx);
  ctx.doc.save(safeFile(`Mission Report - ${name} (ARNOBOT).pdf`));
}

// ── 2 / 3. Daily and Monthly Mission Summary ────────────────────────────────
interface SummaryAgg {
  total: number;
  completed: number;
  aborted: number;
  distanceCovered: number;
  distancePlanned: number;
  duration: number;
  wpReached: number;
  wpTotal: number;
}
function aggregate(missions: ClientMissionDto[]): SummaryAgg {
  return missions.reduce<SummaryAgg>(
    (a, m) => {
      a.total += 1;
      if (m.result === 'completed') a.completed += 1;
      else a.aborted += 1;
      a.distanceCovered += m.distance_m || 0;
      a.distancePlanned += m.distance_planned_m || 0;
      a.duration += m.duration_s || 0;
      a.wpReached += m.waypoints_reached || 0;
      a.wpTotal += m.waypoints_total || 0;
      return a;
    },
    { total: 0, completed: 0, aborted: 0, distanceCovered: 0, distancePlanned: 0, duration: 0, wpReached: 0, wpTotal: 0 },
  );
}

/**
 * Daily summary: `period` = IST day "2026-05-30". Monthly: `period` = "2026-05" (subtitle "May 2026").
 * Missions in the order the API lists them (newest first), as the GCS.
 */
export async function summaryPdf(opts: { kind: 'daily' | 'monthly'; period: string; missions: ClientMissionDto[]; robot: ReportRobot }): Promise<void> {
  const { kind, period, missions, robot } = opts;
  const agg = aggregate(missions);
  const title = kind === 'daily' ? 'Daily Mission Summary' : 'Monthly Mission Summary';
  const subtitle = kind === 'daily' ? period : new Date(`${period}-15T12:00:00+05:30`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const firstCol: Col<ClientMissionDto> =
    kind === 'daily' ? { label: 'Started', w: 85, value: (m) => pdfClock(m.started_at) } : { label: 'Date', w: 85, value: (m) => pdfDate(m.started_at) };

  const ctx = await newCtx();
  bandTop(ctx);
  titleBlock(ctx, title, subtitle, robotLine(robot));
  statGrid(ctx, [
    { label: 'Total missions', value: String(agg.total) },
    { label: 'Completed', value: String(agg.completed) },
    { label: 'Aborted', value: String(agg.aborted) },
    { label: 'Total duration', value: pdfDuration(agg.duration) },
    { label: 'Distance covered', value: pdfDist(agg.distanceCovered) },
    { label: 'Distance planned', value: pdfDist(agg.distancePlanned) },
    { label: 'Waypoints reached', value: `${agg.wpReached} / ${agg.wpTotal}` },
    { label: 'Success rate', value: agg.total ? `${Math.round((agg.completed / agg.total) * 100)}%` : '—' },
  ]);
  ctx.y += 6;
  sectionBar(ctx, `Missions (${missions.length})`);
  table<ClientMissionDto>(
    ctx,
    [
      firstCol,
      // GCS: Mission 175 / WP 30; WP is wider here because field routes have 100+ waypoints ("83/144").
      { label: 'Mission', w: 160, value: (m) => m.name || 'Mission' },
      { label: 'Status', w: 80, value: (m) => statusText(m.result), color: (m) => statusColor(m.result) },
      { label: 'Covered', w: 70, value: (m) => pdfDist(m.distance_m) },
      { label: 'Duration', w: 75, value: (m) => pdfDuration(m.duration_s) },
      { label: 'WP', w: 45, value: (m) => (m.waypoints_total === null ? '—' : `${m.waypoints_reached ?? 0}/${m.waypoints_total}`) },
    ],
    missions,
    'No missions in this period.',
  );
  footers(ctx);
  ctx.doc.save(safeFile(`${title} - ${subtitle} (ARNOBOT).pdf`));
}
