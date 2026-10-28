'use client';

/**
 * Arnobot-branded PDF chrome, ported 1:1 from the GCS (gcs_frontend features/reports/reports.ts + envReports.ts) so
 * every portal report renders exactly like the GCS's: A4 in points, the colour logo trimmed to 150 pt with a navy rule
 * on every page, navy title / blue subtitle, light stat boxes (4 per row), full-width navy section bars, zebra tables
 * whose navy header repeats on page breaks, and the confidential footer with "Page X / N".
 */
type Doc = import('jspdf').jsPDF;
export type Rgb = readonly [number, number, number];

// ── theme (GCS values) ──────────────────────────────────────────────────────
export const NAVY: Rgb = [27, 42, 73]; // title, section/table header bars
export const ACCENT: Rgb = [43, 108, 176]; // subtitle (mission/period name)
export const BOX_BG: Rgb = [238, 241, 245]; // stat-box background
export const LABEL: Rgb = [107, 114, 128]; // stat/label grey
export const VALUE: Rgb = [31, 41, 55]; // primary value text
export const GREEN: Rgb = [22, 138, 84]; // completed status
export const RED: Rgb = [192, 57, 43]; // aborted status
export const AMBER: Rgb = [217, 119, 6];
const ZEBRA: Rgb = [243, 245, 248]; // alternate table row
const FOOT_LINE: Rgb = [210, 214, 220]; // footer divider
export const MX = 40; // page margin

export const setFill = (d: Doc, c: Rgb) => d.setFillColor(c[0], c[1], c[2]);
export const setText = (d: Doc, c: Rgb) => d.setTextColor(c[0], c[1], c[2]);
export const setDraw = (d: Doc, c: Rgb) => d.setDrawColor(c[0], c[1], c[2]);

// ── formatting (GCS pdfDuration / pdfDist / pdfTime / pdfClock; times always IST) ──
const IST = 'Asia/Kolkata';
export function pdfDuration(s: number | null | undefined): string {
  if (!s || s <= 0) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
export function pdfDist(m: number | null | undefined): string {
  if (!m || m <= 0) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
}
/** "30/5/2026, 14:55:36" */
export function pdfTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { hour12: false, timeZone: IST });
}
/** "14:55:36" */
export function pdfClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour12: false, timeZone: IST });
}
/** IST calendar day "2026-05-30". */
export function pdfDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: IST });
}
export const safeFile = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim();

// ── page furniture ──────────────────────────────────────────────────────────
export interface Logo {
  url: string;
  w: number;
  h: number;
}
export interface Ctx {
  doc: Doc;
  pageW: number;
  pageH: number;
  usable: number;
  logo: Logo | null;
  y: number;
}

let logoCache: Promise<Logo | null> | null = null;
/** The ARNOBOT logo trimmed to its content, 150 pt wide; null when it cannot load (the PDF is made without it). */
export function loadLogo(): Promise<Logo | null> {
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
    img.src = '/images/arnobot-logo.png';
  });
  return logoCache;
}

/** A new A4 (pt) document with the logo loaded. */
export async function newCtx(): Promise<Ctx> {
  const [{ jsPDF }, logo] = await Promise.all([import('jspdf'), loadLogo()]);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  return { doc, pageW, pageH: doc.internal.pageSize.getHeight(), usable: pageW - MX * 2, logo, y: 0 };
}

/** Top band (logo + rule) drawn on every page; sets ctx.y to the content start. */
export function bandTop(ctx: Ctx) {
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

export const ensureRoom = (ctx: Ctx, needed: number) => {
  if (ctx.y + needed > ctx.pageH - 56) {
    ctx.doc.addPage();
    bandTop(ctx);
  }
};

/** Title + subtitle (+ optional grey id line), shared by every report type. */
export function titleBlock(ctx: Ctx, title: string, subtitle: string, subId?: string) {
  const { doc } = ctx;
  setText(doc, NAVY);
  doc.setFont('helvetica', 'bold').setFontSize(22);
  doc.text(title, MX, ctx.y);
  ctx.y += 18;
  setText(doc, ACCENT);
  doc.setFont('helvetica', 'normal').setFontSize(12);
  const lines: string[] = doc.splitTextToSize(subtitle, ctx.usable);
  lines.forEach((l, i) => doc.text(l, MX, ctx.y + i * 14));
  ctx.y += (lines.length - 1) * 14 + (subId ? 14 : 18);
  if (subId) {
    setText(doc, LABEL);
    doc.setFontSize(9);
    doc.text(subId, MX, ctx.y);
    ctx.y += 18;
  }
}

/** Centered status pill (completed → green, otherwise red). */
export function statusBadge(ctx: Ctx, status: string) {
  const { doc, pageW } = ctx;
  const label = status.toUpperCase();
  doc.setFont('helvetica', 'bold').setFontSize(10);
  const w = Math.max(150, doc.getTextWidth(label) + 44);
  const h = 22;
  setFill(doc, status === 'completed' ? GREEN : status === 'in_progress' ? AMBER : RED);
  doc.roundedRect((pageW - w) / 2, ctx.y, w, h, 4, 4, 'F');
  doc.setTextColor(255, 255, 255);
  doc.text(label, pageW / 2, ctx.y + 15, { align: 'center' });
  ctx.y += h + 16;
}

/** Full-width navy section header bar. */
export function sectionBar(ctx: Ctx, text: string) {
  const { doc } = ctx;
  setFill(doc, NAVY);
  doc.rect(MX, ctx.y, ctx.usable, 24, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(255, 255, 255);
  doc.text(text, MX + 12, ctx.y + 16);
  ctx.y += 24;
}

/** Grid of light stat boxes, 4 per row (values may wrap to 2 lines). */
export function statGrid(ctx: Ctx, items: { label: string; value: string }[]) {
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

/** Light sub-section header with a coloured left edge and a grey note on the right (GCS envReports). */
export function subSection(ctx: Ctx, text: string, color: Rgb, meta: string) {
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

/** A wrapped paragraph. */
export function note(ctx: Ctx, text: string, color: Rgb = VALUE) {
  const { doc } = ctx;
  doc.setFont('helvetica', 'normal').setFontSize(9);
  setText(doc, color);
  const lines: string[] = doc.splitTextToSize(text, ctx.usable);
  ensureRoom(ctx, lines.length * 12 + 4);
  lines.forEach((ln, i) => doc.text(ln, MX, ctx.y + 10 + i * 12));
  ctx.y += lines.length * 12 + 4;
}

export interface Col<T> {
  label: string;
  w: number;
  value: (row: T) => string;
  /** A coloured (bold) cell, e.g. the status column. */
  color?: (row: T) => Rgb | null;
}
/** Zebra table with a navy header that repeats (with the logo band) on page breaks; long cells wrap. */
export function table<T>(ctx: Ctx, cols: Col<T>[], rows: T[], emptyText: string) {
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
    let x = MX + 8;
    cells.forEach((lines, ci) => {
      const col = cols[ci].color?.(row) ?? null;
      doc.setFont('helvetica', col ? 'bold' : 'normal').setFontSize(9);
      setText(doc, col ?? VALUE);
      lines.forEach((ln, li) => doc.text(ln, x, ctx.y + 13 + li * 11));
      x += cols[ci].w;
    });
    ctx.y += rowH;
  });
}

/** Confidential footer + page numbers, stamped on every page at the end. */
export function footers(ctx: Ctx) {
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
