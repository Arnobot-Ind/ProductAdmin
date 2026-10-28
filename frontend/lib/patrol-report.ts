'use client';

/**
 * Patrol / Night Surveillance Report PDF for one robot and one IST window, laid out like the GCS's report
 * (GCS frontend features/logs/report.ts, itself modelled on the hand-made Adani report of 4 Oct 2026): logo band,
 * title block, summary stat boxes, executive summary, hour-by-hour table, the patrol route on satellite imagery,
 * a minute-by-minute activity bar and coverage notes, with the confidential footer on every page.
 *
 * The figures come from the server (GET /robots/:id/reports/day). Person detections are not part of it: the robot
 * keeps them on board and does not send them to the portal.
 */
import type { DayReportDto, ReportPathPointDto } from '@arnobot/message-schema';

type Doc = import('jspdf').jsPDF;
type Rgb = readonly [number, number, number];

// ── theme (same values as the GCS reports) ──────────────────────────────────
const NAVY: Rgb = [27, 42, 73];
const ACCENT: Rgb = [43, 108, 176];
const BOX_BG: Rgb = [238, 241, 245];
const LABEL: Rgb = [107, 114, 128];
const VALUE: Rgb = [31, 41, 55];
const GREEN: Rgb = [22, 138, 84];
const AMBER: Rgb = [217, 119, 6];
const ZEBRA: Rgb = [243, 245, 248];
const FOOT_LINE: Rgb = [210, 214, 220];
const MX = 40;

const setFill = (d: Doc, c: Rgb) => d.setFillColor(c[0], c[1], c[2]);
const setText = (d: Doc, c: Rgb) => d.setTextColor(c[0], c[1], c[2]);
const setDraw = (d: Doc, c: Rgb) => d.setDrawColor(c[0], c[1], c[2]);

// ── IST formatting ──────────────────────────────────────────────────────────
const IST = 'Asia/Kolkata';
const istHm = (iso: string | number) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });
const istClock = (iso: string | number) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: IST, hour12: false });
const endHm = (iso: string) => (istHm(iso) === '00:00' ? '24:00' : istHm(iso));
const fmtMin = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const kmh = (mps: number | null) => (mps === null ? '—' : (mps * 3.6).toFixed(1));
const safeFile = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim();

// ── page furniture ──────────────────────────────────────────────────────────
interface Logo {
  url: string;
  w: number;
  h: number;
}
interface Ctx {
  doc: Doc;
  pageW: number;
  pageH: number;
  usable: number;
  logo: Logo | null;
  y: number;
}

let logoCache: Promise<Logo | null> | null = null;
/** The ARNOBOT logo trimmed to its content, 150 pt wide; null when it cannot load (the PDF is made without it). */
function loadLogo(): Promise<Logo | null> {
  logoCache ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 1000 / img.naturalWidth);
        const sw = Math.round(img.naturalWidth * scale);
        const sh = Math.round(img.naturalHeight * scale);
        const cv = document.createElement('canvas');
        cv.width = sw;
        cv.height = sh;
        const cx = cv.getContext('2d')!;
        cx.drawImage(img, 0, 0, sw, sh);
        const { data } = cx.getImageData(0, 0, sw, sh);
        let [minX, minY, maxX, maxY] = [sw, sh, 0, 0];
        for (let py = 0; py < sh; py++) {
          for (let px = 0; px < sw; px++) {
            const i = (py * sw + px) * 4;
            const white = data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245;
            if (data[i + 3] > 16 && !white) {
              minX = Math.min(minX, px);
              maxX = Math.max(maxX, px);
              minY = Math.min(minY, py);
              maxY = Math.max(maxY, py);
            }
          }
        }
        if (maxX <= minX || maxY <= minY) [minX, minY, maxX, maxY] = [0, 0, sw - 1, sh - 1];
        const cw = maxX - minX + 1;
        const ch = maxY - minY + 1;
        const out = document.createElement('canvas');
        out.width = cw;
        out.height = ch;
        out.getContext('2d')!.drawImage(cv, minX, minY, cw, ch, 0, 0, cw, ch);
        resolve({ url: out.toDataURL('image/png'), w: 150, h: 150 * (ch / cw) });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = '/brand/arnobot-logo-black.png';
  });
  return logoCache;
}

function bandTop(ctx: Ctx) {
  const { doc, pageW, logo } = ctx;
  if (logo) doc.addImage(logo.url, 'PNG', MX, 26, logo.w, logo.h);
  else {
    doc.setFont('helvetica', 'bold').setFontSize(18);
    setText(doc, NAVY);
    doc.text('ARNOBOT', MX, 56);
  }
  setDraw(doc, NAVY);
  doc.setLineWidth(1.4);
  doc.line(MX, 80, pageW - MX, 80);
  doc.setLineWidth(0.2);
  ctx.y = 104;
}
const ensureRoom = (ctx: Ctx, needed: number) => {
  if (ctx.y + needed > ctx.pageH - 56) {
    ctx.doc.addPage();
    bandTop(ctx);
  }
};

function titleBlock(ctx: Ctx, title: string, subtitle: string, subId: string) {
  const { doc } = ctx;
  setText(doc, NAVY);
  doc.setFont('helvetica', 'bold').setFontSize(22);
  doc.text(title, MX, ctx.y);
  ctx.y += 18;
  setText(doc, ACCENT);
  doc.setFont('helvetica', 'normal').setFontSize(12);
  const lines: string[] = doc.splitTextToSize(subtitle, ctx.usable);
  lines.forEach((l, i) => doc.text(l, MX, ctx.y + i * 14));
  ctx.y += lines.length * 14;
  setText(doc, LABEL);
  doc.setFontSize(9);
  doc.text(subId, MX, ctx.y);
  ctx.y += 18;
}

function sectionBar(ctx: Ctx, text: string) {
  const { doc } = ctx;
  setFill(doc, NAVY);
  doc.rect(MX, ctx.y, ctx.usable, 24, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(255, 255, 255);
  doc.text(text, MX + 12, ctx.y + 16);
  ctx.y += 24;
}

function statGrid(ctx: Ctx, items: { label: string; value: string }[]) {
  const { doc } = ctx;
  const cols = 4;
  const gap = 10;
  const boxW = (ctx.usable - gap * (cols - 1)) / cols;
  const boxH = 50;
  items.forEach((it, i) => {
    const x = MX + (i % cols) * (boxW + gap);
    const yy = ctx.y + Math.floor(i / cols) * (boxH + gap);
    setFill(doc, BOX_BG);
    doc.roundedRect(x, yy, boxW, boxH, 4, 4, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(7);
    setText(doc, LABEL);
    doc.text(it.label.toUpperCase(), x + 9, yy + 16);
    doc.setFontSize(11);
    setText(doc, VALUE);
    (doc.splitTextToSize(it.value, boxW - 16) as string[]).slice(0, 2).forEach((ln, li) => doc.text(ln, x + 9, yy + 31 + li * 12));
  });
  ctx.y += Math.ceil(items.length / cols) * (boxH + gap) + 4;
}

function subSection(ctx: Ctx, text: string, color: Rgb, meta: string) {
  const { doc } = ctx;
  ensureRoom(ctx, 80);
  setFill(doc, BOX_BG);
  doc.rect(MX, ctx.y, ctx.usable, 22, 'F');
  setFill(doc, color);
  doc.rect(MX, ctx.y, 4, 22, 'F');
  setText(doc, NAVY);
  doc.setFont('helvetica', 'bold').setFontSize(11);
  doc.text(text, MX + 12, ctx.y + 15);
  setText(doc, LABEL);
  doc.setFont('helvetica', 'normal').setFontSize(8.5);
  doc.text(meta, MX + ctx.usable - 8, ctx.y + 15, { align: 'right' });
  ctx.y += 30;
}

function note(ctx: Ctx, text: string, color: Rgb = VALUE) {
  const { doc } = ctx;
  doc.setFont('helvetica', 'normal').setFontSize(9);
  setText(doc, color);
  const lines: string[] = doc.splitTextToSize(text, ctx.usable);
  ensureRoom(ctx, lines.length * 12 + 4);
  lines.forEach((ln, i) => doc.text(ln, MX, ctx.y + 10 + i * 12));
  ctx.y += lines.length * 12 + 4;
}

interface Col<T> {
  label: string;
  w: number;
  value: (row: T) => string;
}
/** Zebra table with a navy header that repeats (with the logo band) on page breaks; long cells wrap. */
function table<T>(ctx: Ctx, cols: Col<T>[], rows: T[], emptyText: string) {
  const { doc } = ctx;
  const headH = 22;
  const drawHead = () => {
    setFill(doc, NAVY);
    doc.rect(MX, ctx.y, ctx.usable, headH, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(255, 255, 255);
    let x = MX + 8;
    for (const c of cols) {
      doc.text(c.label, x, ctx.y + 15);
      x += c.w;
    }
    ctx.y += headH;
  };
  drawHead();
  if (!rows.length) {
    setText(doc, LABEL);
    doc.setFont('helvetica', 'italic').setFontSize(9);
    doc.text(emptyText, MX + 8, ctx.y + 14);
    ctx.y += 20;
    return;
  }
  rows.forEach((row, idx) => {
    doc.setFont('helvetica', 'normal').setFontSize(9);
    const cells = cols.map((c) => doc.splitTextToSize(c.value(row), c.w - 8) as string[]);
    const rowH = Math.max(20, Math.max(...cells.map((c) => c.length)) * 11 + 9);
    if (ctx.y + rowH > ctx.pageH - 56) {
      doc.addPage();
      bandTop(ctx);
      drawHead();
    }
    if (idx % 2 === 1) {
      setFill(doc, ZEBRA);
      doc.rect(MX, ctx.y, ctx.usable, rowH, 'F');
    }
    setText(doc, VALUE);
    let x = MX + 8;
    cells.forEach((lines, ci) => {
      lines.forEach((ln, li) => doc.text(ln, x, ctx.y + 13 + li * 11));
      x += cols[ci].w;
    });
    ctx.y += rowH;
  });
}

function footers(ctx: Ctx) {
  const { doc, pageW, pageH } = ctx;
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    setDraw(doc, FOOT_LINE);
    doc.setLineWidth(0.5);
    doc.line(MX, pageH - 42, pageW - MX, pageH - 42);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(120, 120, 120);
    doc.text('Arnobot Private Limited  |  Private & Confidential', MX, pageH - 30);
    doc.text(`Page ${p} / ${pages}`, pageW - MX, pageH - 30, { align: 'right' });
    doc.setFont('helvetica', 'italic').setFontSize(7.5).setTextColor(150, 150, 150);
    doc.text('This report is system-generated and may contain discrepancies with actual field data.', pageW / 2, pageH - 18, { align: 'center' });
  }
}

// ── patrol route on satellite imagery (port of GCS features/logs/routeMap.ts) ─
const TILE = 256;
const TILE_URL = (z: number, x: number, y: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const GAP_MS = 30_000;
const RAMP = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];
function rampColor(f: number): string {
  const x = Math.min(1, Math.max(0, f)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const t = x - i;
  const c = RAMP[i].map((v, k) => Math.round(v + (RAMP[i + 1][k] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function project(lat: number, lon: number, z: number): [number, number] {
  const s = TILE * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
}
function loadTile(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The cleaned track on Esri World Imagery, coloured by time, dashed where estimated. JPEG data URL, or null. */
async function renderRouteMap(pts: ReportPathPointDto[]): Promise<string | null> {
  if (pts.length < 2) return null;
  const W = 1600;
  const H = 1000;
  const PAD = 70;
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  let z = 18;
  for (; z > 3; z--) {
    const [x0, y1] = project(minLat, minLon, z);
    const [x1, y0] = project(maxLat, maxLon, z);
    if (x1 - x0 <= W - 2 * PAD && y1 - y0 <= H - 2 * PAD) break;
  }
  const [cx0, cy1] = project(minLat, minLon, z);
  const [cx1, cy0] = project(maxLat, maxLon, z);
  const ox = (cx0 + cx1) / 2 - W / 2;
  const oy = (cy0 + cy1) / 2 - H / 2;
  const toCanvas = (p: ReportPathPointDto): [number, number] => {
    const [x, y] = project(p.lat, p.lon, z);
    return [x - ox, y - oy];
  };

  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#2b2f36';
  g.fillRect(0, 0, W, H);
  const jobs: Promise<void>[] = [];
  for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + W) / TILE); tx++) {
    for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + H) / TILE); ty++) {
      jobs.push(
        loadTile(TILE_URL(z, tx, ty)).then((img) => {
          if (img) g.drawImage(img, tx * TILE - ox, ty * TILE - oy, TILE, TILE);
        }),
      );
    }
  }
  await Promise.all(jobs);

  const time = (p: ReportPathPointDto) => Date.parse(p.t);
  const t0 = time(pts[0]);
  const t1 = time(pts[pts.length - 1]);
  const spanMs = Math.max(1, t1 - t0);
  const linked = (i: number) => time(pts[i]) - time(pts[i - 1]) <= GAP_MS;
  const est = (i: number) => pts[i - 1].est || pts[i].est;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // Outlines first, then measured segments in their time colour, then each estimated stretch as ONE dashed line.
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 9;
  for (let i = 1; i < pts.length; i++) {
    if (!linked(i)) continue;
    g.beginPath();
    g.moveTo(...toCanvas(pts[i - 1]));
    g.lineTo(...toCanvas(pts[i]));
    g.stroke();
  }
  g.lineWidth = 5;
  for (let i = 1; i < pts.length; i++) {
    if (!linked(i) || est(i)) continue;
    g.strokeStyle = rampColor((time(pts[i]) - t0) / spanMs);
    g.beginPath();
    g.moveTo(...toCanvas(pts[i - 1]));
    g.lineTo(...toCanvas(pts[i]));
    g.stroke();
  }
  g.strokeStyle = '#ffffff';
  g.setLineDash([14, 10]);
  for (let i = 1; i < pts.length; i++) {
    if (!linked(i) || !est(i)) continue;
    g.beginPath();
    g.moveTo(...toCanvas(pts[i - 1]));
    while (i < pts.length && linked(i) && est(i)) {
      g.lineTo(...toCanvas(pts[i]));
      i++;
    }
    g.stroke();
  }
  g.setLineDash([]);

  const label = (x: number, y: number, text: string) => {
    g.font = 'bold 22px Helvetica, Arial, sans-serif';
    const w = g.measureText(text).width + 16;
    const lx = Math.min(W - w - 6, Math.max(6, x + 14));
    const ly = Math.min(H - 34, Math.max(6, y - 34));
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillRect(lx, ly, w, 30);
    g.fillStyle = '#1b2a49';
    g.fillText(text, lx + 8, ly + 22);
  };
  const [sx, sy] = toCanvas(pts[0]);
  const [ex, ey] = toCanvas(pts[pts.length - 1]);
  g.fillStyle = '#16a34a';
  g.strokeStyle = '#fff';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(sx, sy, 12, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#c0392b';
  g.fillRect(ex - 11, ey - 11, 22, 22);
  g.strokeRect(ex - 11, ey - 11, 22, 22);
  label(sx, sy, `Start ${istHm(t0)} IST`);
  label(ex, ey, `Last position ${istHm(t1)} IST`);

  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillRect(20, 20, 440, 74);
  for (let i = 0; i < 200; i++) {
    g.fillStyle = rampColor(i / 199);
    g.fillRect(36 + i * 2, 34, 2, 14);
  }
  g.font = '18px Helvetica, Arial, sans-serif';
  g.fillStyle = '#1b2a49';
  g.fillText(istHm(t0), 36, 70);
  g.fillText(istHm(t1), 36 + 400 - g.measureText(istHm(t1)).width, 70);
  g.fillText('time (IST)', 160, 70);
  g.setLineDash([10, 8]);
  g.strokeStyle = '#1b2a49';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(36, 86);
  g.lineTo(96, 86);
  g.stroke();
  g.setLineDash([]);
  g.font = '15px Helvetica, Arial, sans-serif';
  g.fillText('dashed = no reliable GPS fix, position estimated', 104, 91);

  const mPerPx = (156543.03392 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)) / 2 ** z;
  const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((m) => m / mPerPx >= 120) ?? 5000;
  const barPx = nice / mPerPx;
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillRect(20, H - 64, barPx + 40, 44);
  g.fillStyle = '#1b2a49';
  g.fillRect(40, H - 34, barPx, 6);
  g.font = 'bold 17px Helvetica, Arial, sans-serif';
  g.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 40, H - 42);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fillRect(W - 70, 20, 50, 70);
  g.fillStyle = '#1b2a49';
  g.beginPath();
  g.moveTo(W - 45, 30);
  g.lineTo(W - 57, 62);
  g.lineTo(W - 33, 62);
  g.fill();
  g.font = 'bold 20px Helvetica, Arial, sans-serif';
  g.fillText('N', W - 52, 84);
  g.font = '13px Helvetica, Arial, sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillText('Imagery: Esri, Maxar, Earthstar Geographics', W - 300, H - 10);
  try {
    return cv.toDataURL('image/jpeg', 0.85);
  } catch {
    return null; // a tile without CORS tainted the canvas
  }
}

/** Minute-by-minute activity: parked / patrolling / no data, with time ticks. */
function activityBar(ctx: Ctx, r: DayReportDto, dayLabel: string) {
  const { doc } = ctx;
  ensureRoom(ctx, 90);
  const x0 = MX;
  const w = ctx.usable;
  const y = ctx.y + 22;
  const h = 26;
  const mins = r.activity.length;
  const startMs = Date.parse(r.from);
  const colors: Record<number, Rgb> = { 0: [215, 218, 223], 1: NAVY, 2: [34, 139, 84] };
  const legend: [number, string][] = [
    [1, 'Online (parked)'],
    [2, 'Patrolling (> 0.2 m/s)'],
    [0, 'No data'],
  ];
  let lx = x0 + w / 2 - 140;
  doc.setFont('helvetica', 'normal').setFontSize(8);
  for (const [k, txt] of legend) {
    setFill(doc, colors[k]);
    doc.rect(lx, ctx.y + 6, 14, 8, 'F');
    setText(doc, NAVY);
    doc.text(txt, lx + 18, ctx.y + 13);
    lx += doc.getTextWidth(txt) + 34;
  }
  r.activity.forEach((s, i) => {
    setFill(doc, colors[s] ?? colors[0]);
    doc.rect(x0 + (i / mins) * w, y, w / mins + 0.3, h, 'F');
  });
  const stepMin = mins > 300 ? 60 : mins > 90 ? 15 : 5;
  setText(doc, LABEL);
  doc.setFontSize(7.5);
  for (let m = 0; m <= mins; m += stepMin) doc.text(istHm(startMs + m * 60_000), x0 + (m / mins) * w, y + h + 10, { align: 'center' });
  ctx.y = y + h + 22;
  doc.setFontSize(8);
  doc.text(`Robot activity, ${dayLabel}, ${istHm(r.from)}–${endHm(r.to)} IST.`, x0, ctx.y);
  ctx.y += 8;
}

// ── the report ──────────────────────────────────────────────────────────────
export async function downloadPatrolReport(r: DayReportDto): Promise<void> {
  const [{ jsPDF }, logo] = await Promise.all([import('jspdf'), loadLogo()]);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const ctx: Ctx = { doc, pageW: doc.internal.pageSize.getWidth(), pageH: doc.internal.pageSize.getHeight(), usable: doc.internal.pageSize.getWidth() - MX * 2, logo, y: 0 };
  const s = r.summary;
  const title = r.night ? 'Night Surveillance Report' : 'Patrol Report';
  const dayLabel = new Date(`${r.date}T12:00:00+05:30`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const windowLabel = `${istHm(r.from)}–${endHm(r.to)} IST`;
  const kind = r.night ? 'night patrol' : 'patrol';
  const onlineMin = Math.round(s.online_s / 60);
  const movingMin = Math.round(s.moving_s / 60);

  bandTop(ctx);
  ctx.y += 10;
  titleBlock(
    ctx,
    title,
    [r.owner_company, r.site, dayLabel, windowLabel].filter(Boolean).join(' · '),
    `Robot ${r.robot_name} · ${r.product_name} · ${r.night ? 'Night patrol' : 'Patrol'} · Generated ${new Date().toLocaleString('en-GB', { timeZone: IST })} · Prepared by Arnobot Private Limited`,
  );
  sectionBar(ctx, 'Summary');
  ctx.y += 12;
  statGrid(ctx, [
    { label: 'Distance patrolled', value: s.distance_source === 'none' ? '—' : km(s.distance_m) },
    { label: 'Robot online', value: fmtMin(s.online_s) },
    { label: 'Time on the move', value: `${movingMin} min · ${s.online_s ? Math.round((s.moving_s / s.online_s) * 100) : 0}%` },
    { label: 'Peak / avg speed', value: `${kmh(s.peak_mps)} / ${kmh(s.avg_moving_mps)} km/h` },
    { label: 'GPS fix (reliable)', value: s.gps_reliable_pct === null ? '—' : `${s.gps_reliable_pct} %` },
    { label: 'Satellites (median)', value: s.median_sats === null ? '—' : String(s.median_sats) },
    { label: 'Battery', value: s.battery_start_pct === null ? '—' : `${Math.round(s.battery_start_pct)} % → ${Math.round(s.battery_end_pct!)} %` },
    { label: 'Lowest battery', value: s.battery_min_pct === null ? '—' : `${Math.round(s.battery_min_pct)} %` },
  ]);

  subSection(ctx, 'Executive summary', ACCENT, `${kind} · ${dayLabel} · ${windowLabel.replace(' IST', '')}`);
  const site = r.owner_company ? ` for ${r.owner_company}` : '';
  note(
    ctx,
    s.online_s === 0
      ? `Arnobot's robot ${r.robot_name} did not report to the Arnobot portal on ${dayLabel}, ${windowLabel}, so there is no patrol data for this period.`
      : `Arnobot's robot ${r.robot_name} was on ${kind}${site} on ${dayLabel}, ${windowLabel}. ` +
          `It was online for ${fmtMin(s.online_s)} and on the move for ${movingMin} min, covering ${km(s.distance_m)}` +
          (s.peak_mps ? ` at up to ${kmh(s.peak_mps)} km/h` : '') +
          '. ' +
          (s.battery_start_pct !== null ? `Its battery went from ${Math.round(s.battery_start_pct)} % to ${Math.round(s.battery_end_pct!)} % (lowest ${Math.round(s.battery_min_pct!)} %). ` : '') +
          (r.offline_gaps.length ? `It was out of contact ${r.offline_gaps.length} time${r.offline_gaps.length > 1 ? 's' : ''} during the period (see coverage notes).` : 'It reported throughout the period.'),
  );
  ctx.y += 10;

  // Hour by hour.
  subSection(ctx, 'Hour by hour', NAVY, `${r.hours.length} hour${r.hours.length !== 1 ? 's' : ''}`);
  type HourRow = { label: string; online: number; dist: number; moving: number };
  // Hours on the next IST day are marked, e.g. "00:00 – 01:00 (8 Oct)", as in the GCS report.
  const istDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: IST });
  const nextDay = (iso: string) => (istDay(iso) !== r.date ? ` (${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: IST })})` : '');
  const hourRows: HourRow[] = r.hours.map((h) => ({ label: `${istHm(h.from)} – ${endHm(h.to)}${nextDay(h.from)}`, online: h.online_min, dist: h.distance_m, moving: h.moving_s }));
  hourRows.push({ label: 'Total', online: onlineMin, dist: s.distance_m, moving: s.moving_s });
  const hw = ctx.usable / 4;
  table<HourRow>(
    ctx,
    [
      { label: 'Hour (IST)', w: hw, value: (x) => x.label },
      { label: 'Robot online', w: hw, value: (x) => `${x.online} min` },
      { label: 'Distance', w: hw, value: (x) => km(x.dist) },
      { label: 'Time moving', w: hw, value: (x) => `${Math.round(x.moving / 60)} min` },
    ],
    hourRows,
    '',
  );

  // Patrol route + activity bar.
  doc.addPage();
  bandTop(ctx);
  ctx.y += 20;
  subSection(ctx, 'Patrol route', GREEN, `${km(s.distance_m)} patrolled`);
  note(
    ctx,
    `The robot was on patrol for ${movingMin} of its ${onlineMin} online minutes` +
      (s.avg_moving_mps ? `, at an average of ${s.avg_moving_mps.toFixed(1)} m/s (${kmh(s.avg_moving_mps)} km/h)` : '') +
      '.' +
      (r.longest_legs.length
        ? ` The longest continuous leg${r.longest_legs.length > 1 ? 's were' : ' was'} ${r.longest_legs.map((l) => `${istHm(l.from)}–${istHm(l.to)} (${Math.round((Date.parse(l.to) - Date.parse(l.from)) / 60000)} min)`).join(' and ')}.`
        : '') +
      (s.distance_source === 'odometer'
        ? ` Distance is measured by the robot's wheel odometer (${Math.round(s.distance_m).toLocaleString('en-IN')} m).`
        : s.distance_source === 'wheel_speed'
          ? ` Distance is measured from the robot's wheel speed (${Math.round(s.distance_m).toLocaleString('en-IN')} m).`
          : ''),
  );
  ctx.y += 6;
  const img = await renderRouteMap(r.path);
  if (img) {
    const w = ctx.usable;
    const h = w * (1000 / 1600);
    ensureRoom(ctx, h + 30);
    doc.addImage(img, 'JPEG', MX, ctx.y, w, h);
    ctx.y += h + 6;
    doc.setFont('helvetica', 'normal').setFontSize(8);
    setText(doc, LABEL);
    const mid = r.path[Math.floor(r.path.length / 2)];
    doc.text(
      doc.splitTextToSize(
        `Patrol track on satellite imagery, coloured by time (IST). Solid = measured GPS track; dashed = position estimated while the GPS fix was not reliable.${r.path_hidden > 0 ? ` ${r.path_hidden} positions without a reliable fix are left out.` : ''} Track centre ${mid.lat.toFixed(4)} N, ${mid.lon.toFixed(4)} E.`,
        ctx.usable,
      ),
      MX,
      ctx.y + 8,
    );
    ctx.y += 30;
  } else {
    note(ctx, 'No GPS positions were recorded in this period, so the route cannot be drawn.', LABEL);
  }
  activityBar(ctx, r, dayLabel);

  // Coverage & system notes.
  ctx.y += 14;
  subSection(ctx, 'Coverage & system notes', AMBER, 'for the operations team');
  const gaps = r.offline_gaps;
  const notes: { item: string; detail: string }[] = [
    {
      item: 'Continuous coverage',
      detail: r.longest_online ? `${istClock(r.longest_online.from)} – ${istClock(r.longest_online.to)} IST (${fmtMin((Date.parse(r.longest_online.to) - Date.parse(r.longest_online.from)) / 1000)} unbroken)` : 'No data in this period',
    },
    {
      item: 'Offline gaps',
      detail: gaps.length ? gaps.slice(0, 6).map((g) => `${istHm(g.from)}–${endHm(g.to)}`).join(', ') + (gaps.length > 6 ? ` (+${gaps.length - 6} more)` : '') : 'None — the robot reported throughout',
    },
    {
      item: 'Battery',
      detail: s.battery_start_pct === null ? 'No battery readings in this period' : `${Math.round(s.battery_start_pct)} % to ${Math.round(s.battery_end_pct!)} %, lowest ${Math.round(s.battery_min_pct!)} %`,
    },
    {
      item: 'GPS',
      detail: s.gps_reliable_pct === null ? 'No position recorded' : `Reliable fix ${s.gps_reliable_pct} % of the time${s.median_sats !== null ? ` (median ${s.median_sats} satellites)` : ''}`,
    },
  ];
  if (r.clipped) notes.push({ item: 'Data shown', detail: 'Part of this period is before your organization took over this robot and is not included' });
  table(
    ctx,
    [
      { label: 'Item', w: ctx.usable * 0.28, value: (x: (typeof notes)[number]) => x.item },
      { label: 'Detail', w: ctx.usable * 0.72, value: (x: (typeof notes)[number]) => x.detail },
    ],
    notes,
    '',
  );

  // Missions (Arnobot staff only; the server sends none to customers).
  if (r.missions.length) {
    ctx.y += 14;
    subSection(ctx, 'Missions', NAVY, `${r.missions.length} in this period`);
    const u = ctx.usable;
    table(
      ctx,
      [
        { label: 'Started', w: u * 0.14, value: (m: DayReportDto['missions'][number]) => (m.started_at ? istHm(m.started_at) : '—') },
        { label: 'Ended', w: u * 0.14, value: (m) => (m.ended_at ? istHm(m.ended_at) : '—') },
        { label: 'Mission', w: u * 0.4, value: (m) => m.name ?? m.mission_id },
        { label: 'Result', w: u * 0.17, value: (m) => m.result.replace('_', ' ') },
        { label: 'Distance', w: u * 0.15, value: (m) => (m.distance_m === null ? '—' : km(m.distance_m)) },
      ],
      r.missions,
      '',
    );
  }

  ctx.y += 10;
  note(
    ctx,
    `Source: ${r.robot_name} GPS and wheel-speed telemetry (every second) and live status (every 30 s) received by the Arnobot portal, retrieved ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: IST })}.`,
    LABEL,
  );

  footers(ctx);
  doc.save(safeFile(`${title} - ${r.owner_company ?? r.robot_name} - ${dayLabel} (ARNOBOT).pdf`));
}
