'use client';

/**
 * Mission report PDFs, built in the browser (jsPDF), in the GCS's layout: ARNOBOT logo and a navy rule on every
 * page, navy title / blue subtitle, stat boxes, striped tables that repeat their header, and a footer with the
 * company line, "Page X / N" and a system-generated note. A4 portrait. Each report also names the robot and product.
 *
 *   missionReportPdf    one mission run
 *   summaryPdf          daily / monthly mission summary of one robot
 */
import type { MissionDetailDto, MissionListItemDto } from '@arnobot/message-schema';

type Doc = import('jspdf').jsPDF;
type Rgb = [number, number, number];

const NAVY: Rgb = [20, 38, 84];
const BLUE: Rgb = [56, 85, 157];
const GREEN: Rgb = [21, 128, 61];
const RED: Rgb = [185, 28, 28];
const AMBER: Rgb = [180, 83, 9];
const MUTED: Rgb = [100, 106, 120];
const MARGIN = 14;
const TOP = 30; // content starts below the logo + rule

export interface ReportRobot {
  robot_id: string;
  product_name: string;
  serial_number: string;
  owner_company?: string | null;
}

// ── formatting ──────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const time = (iso: string | null) => (iso ? `${pad(new Date(iso).getHours())}:${pad(new Date(iso).getMinutes())}:${pad(new Date(iso).getSeconds())}` : '-');
const dateTime = (iso: string | null) => (iso ? `${date(iso)} ${time(iso)}` : '-');
function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '-';
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${t % 60}s` : `${t}s`;
}
const distance = (m: number | null | undefined) => (m === null || m === undefined ? '-' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const statusLabel = (r: string) => (r === 'in_progress' ? 'IN PROGRESS' : r.toUpperCase());
const statusColour = (r: string): Rgb => (r === 'completed' ? GREEN : r === 'in_progress' ? AMBER : RED);
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim();

// ── page furniture ──────────────────────────────────────────────────────────
let logoCache: Promise<{ data: string; ratio: number } | null> | null = null;
/** The ARNOBOT logo as a data URL; null when it cannot load (the PDF is then made without it). */
function loadLogo(): Promise<{ data: string; ratio: number } | null> {
  logoCache ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        resolve({ data: c.toDataURL('image/png'), ratio: img.naturalWidth / img.naturalHeight });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = '/brand/arnobot-logo-black.png';
  });
  return logoCache;
}

async function newDoc(): Promise<{ doc: Doc; autoTable: typeof import('jspdf-autotable').autoTable; logo: Awaited<ReturnType<typeof loadLogo>> }> {
  const [{ jsPDF }, { autoTable }, logo] = await Promise.all([import('jspdf'), import('jspdf-autotable'), loadLogo()]);
  return { doc: new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' }), autoTable, logo };
}

/** Logo + navy rule at the top and the footer on EVERY page, once the content is laid out. */
function decorate(doc: Doc, logo: Awaited<ReturnType<typeof loadLogo>>) {
  const pages = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    if (logo) doc.addImage(logo.data, 'PNG', MARGIN, 9, 9 * logo.ratio > 60 ? 60 : 9 * logo.ratio, 9 * logo.ratio > 60 ? 60 / logo.ratio : 9);
    else {
      doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(...NAVY);
      doc.text('ARNOBOT', MARGIN, 16);
    }
    doc.setDrawColor(...NAVY).setLineWidth(0.8).line(MARGIN, 22, w - MARGIN, 22);

    doc.setDrawColor(210, 214, 222).setLineWidth(0.2).line(MARGIN, h - 16, w - MARGIN, h - 16);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
    doc.text('Arnobot Private Limited | Private & Confidential', MARGIN, h - 11);
    doc.text(`Page ${i} / ${pages}`, w - MARGIN, h - 11, { align: 'right' });
    doc.setFontSize(7);
    doc.text('This report is system-generated from robot and GCS data and may not match actual field data.', MARGIN, h - 7);
  }
}

/** Title (navy), subtitle (blue) and small grey lines; returns the y below them. */
function heading(doc: Doc, title: string, subtitle: string, lines: string[]): number {
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...NAVY);
  doc.text(title, MARGIN, TOP + 6);
  doc.setFont('helvetica', 'normal').setFontSize(13).setTextColor(...BLUE);
  doc.text(subtitle, MARGIN, TOP + 13);
  doc.setFontSize(9).setTextColor(...MUTED);
  lines.forEach((l, i) => doc.text(l, MARGIN, TOP + 20 + i * 5));
  return TOP + 20 + lines.length * 5 + 2;
}

function badge(doc: Doc, y: number, text: string, colour: Rgb): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold').setFontSize(11);
  const tw = doc.getTextWidth(text) + 14;
  doc.setFillColor(...colour).roundedRect((w - tw) / 2, y, tw, 9, 2, 2, 'F');
  doc.setTextColor(255, 255, 255).text(text, w / 2, y + 6.2, { align: 'center' });
  return y + 15;
}

/** Stat boxes, four per row. */
function statBoxes(doc: Doc, y: number, items: [string, string][]): number {
  const w = doc.internal.pageSize.getWidth() - MARGIN * 2;
  const gap = 4;
  const bw = (w - gap * 3) / 4;
  const bh = 17;
  items.forEach(([label, value], i) => {
    const x = MARGIN + (i % 4) * (bw + gap);
    const yy = y + Math.floor(i / 4) * (bh + gap);
    doc.setFillColor(243, 245, 250).setDrawColor(220, 225, 235).roundedRect(x, yy, bw, bh, 2, 2, 'FD');
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED);
    doc.text(label.toUpperCase(), x + 3, yy + 5.5);
    doc.setFont('helvetica', 'bold').setFontSize(11.5).setTextColor(...NAVY);
    doc.text(value, x + 3, yy + 13, { maxWidth: bw - 6 });
  });
  return y + Math.ceil(items.length / 4) * (bh + gap) + 3;
}

function section(doc: Doc, y: number, text: string): number {
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(...NAVY);
  doc.text(text, MARGIN, y);
  return y + 3;
}

const tableStyle = {
  theme: 'striped' as const,
  showHead: 'everyPage' as const,
  margin: { top: TOP, left: MARGIN, right: MARGIN, bottom: 22 },
  headStyles: { fillColor: NAVY, textColor: [255, 255, 255] as Rgb, fontStyle: 'bold' as const, fontSize: 8.5 },
  bodyStyles: { fontSize: 8.5, textColor: [30, 34, 44] as Rgb },
  alternateRowStyles: { fillColor: [243, 245, 250] as Rgb },
};

const robotLine = (r: ReportRobot) => `Robot ${r.robot_id} · ${r.product_name} · SN ${r.serial_number}${r.owner_company ? ` · ${r.owner_company}` : ''}`;

// ── 1. Mission Report ───────────────────────────────────────────────────────
export async function missionReportPdf(m: MissionDetailDto, robot: ReportRobot): Promise<void> {
  const { doc, autoTable, logo } = await newDoc();
  const name = m.name ?? m.mission_id;
  let y = heading(doc, 'Mission Report', name, [`Mission ID: ${m.mission_id}`, robotLine(robot)]);
  y = badge(doc, y, statusLabel(m.result), statusColour(m.result));
  y = statBoxes(doc, y, [
    ['Date', date(m.started_at)],
    ['Started', time(m.started_at)],
    ['Ended', time(m.ended_at)],
    ['Duration', duration(m.duration_s)],
    ['Distance covered', distance(m.distance_m)],
    ['Distance planned', distance(m.distance_planned_m)],
    ['Waypoints reached', m.waypoints_total !== null ? `${m.waypoints_reached ?? 0} / ${m.waypoints_total}` : '-'],
    ['End reason', m.end_reason ?? '-'],
  ]);
  const wps = m.waypoints ?? [];
  y = section(doc, y + 4, `Waypoints (${wps.length})`);
  if (wps.length) {
    autoTable(doc, {
      ...tableStyle,
      startY: y + 2,
      head: [['#', 'Label', 'Lat', 'Lng', 'Reached', 'Reached at']],
      body: wps.map((w) => [String(w.sequence), w.label ?? '-', w.lat.toFixed(6), w.lng.toFixed(6), w.reached ? 'Yes' : 'No', dateTime(w.reached_at)]),
      didParseCell: (d) => {
        if (d.section === 'body' && d.column.index === 4) {
          d.cell.styles.textColor = d.cell.raw === 'Yes' ? GREEN : RED;
          d.cell.styles.fontStyle = 'bold';
        }
      },
    });
  } else {
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...MUTED);
    doc.text('The GCS report for this mission did not include per-waypoint results.', MARGIN, y + 6);
  }
  decorate(doc, logo);
  doc.save(`Mission Report - ${safeName(name)} (ARNOBOT).pdf`);
}

// ── 2 / 3. Daily and Monthly Mission Summary ────────────────────────────────
export async function summaryPdf(opts: { kind: 'daily' | 'monthly'; label: string; missions: MissionListItemDto[]; robot: ReportRobot; odometerM?: number | null }): Promise<void> {
  const { doc, autoTable, logo } = await newDoc();
  // Oldest first; a mission without a start time goes last.
  const ms = [...opts.missions].sort((a, b) => (a.started_at ?? '9999').localeCompare(b.started_at ?? '9999'));
  const count = (r: string) => ms.filter((m) => m.result === r).length;
  const sum = (f: (m: MissionListItemDto) => number | null) => ms.reduce((n, m) => n + (f(m) ?? 0), 0);
  const completed = count('completed');
  const wpTotal = sum((m) => m.waypoints_total);
  const title = opts.kind === 'daily' ? 'Daily Mission Summary' : 'Monthly Mission Summary';
  const lines = [robotLine(opts.robot)];
  if (opts.odometerM !== undefined && opts.odometerM !== null) lines.push(`Robot odometer (lifetime, all driving): ${distance(opts.odometerM)}`);
  let y = heading(doc, title, opts.label, lines);
  y = statBoxes(doc, y + 2, [
    ['Total missions', String(ms.length)],
    ['Completed', String(completed)],
    ['Aborted', String(count('aborted') + count('failed'))],
    ['Total duration', duration(sum((m) => m.duration_s))],
    ['Distance covered', distance(sum((m) => m.distance_m))],
    ['Distance planned', distance(sum((m) => m.distance_planned_m))],
    ['Waypoints reached', wpTotal ? `${sum((m) => m.waypoints_reached)} / ${wpTotal}` : '-'],
    ['Success rate', ms.length ? `${Math.round((completed / ms.length) * 100)} %` : '-'],
  ]);
  y = section(doc, y + 4, `Missions (${ms.length})`);
  if (ms.length) {
    autoTable(doc, {
      ...tableStyle,
      startY: y + 2,
      head: [[opts.kind === 'daily' ? 'Started' : 'Date', 'Mission', 'Status', 'Covered', 'Duration', 'WP']],
      body: ms.map((m) => [
        opts.kind === 'daily' ? time(m.started_at) : date(m.started_at),
        m.name ?? m.mission_id,
        statusLabel(m.result),
        distance(m.distance_m),
        duration(m.duration_s),
        m.waypoints_total !== null ? `${m.waypoints_reached ?? 0}/${m.waypoints_total}` : '-',
      ]),
      columnStyles: { 1: { cellWidth: 62 } },
      didParseCell: (d) => {
        if (d.section === 'body' && d.column.index === 2) {
          d.cell.styles.textColor = d.cell.raw === 'COMPLETED' ? GREEN : d.cell.raw === 'IN PROGRESS' ? AMBER : RED;
          d.cell.styles.fontStyle = 'bold';
        }
      },
    });
  } else {
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...MUTED);
    doc.text(`No missions in ${opts.label}.`, MARGIN, y + 6);
  }
  decorate(doc, logo);
  doc.save(`${title} - ${safeName(opts.label)} (ARNOBOT).pdf`);
}
