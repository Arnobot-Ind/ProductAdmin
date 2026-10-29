'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtDuration } from '@/lib/format';
import type { RobotCategory } from '@arnobot/message-schema';

/*
 * Charts in plain HTML (the same look as the client portal's dashboard): one axis each, recessive hairline grid,
 * thin columns with a 4px rounded top, a 2px surface gap between stacked segments, a hover/focus tooltip on every
 * mark, a legend for two or more series, and a table view. Mission results are states, so they wear the reserved
 * status chart fills (completed = good, aborted = warning, failed = critical), always next to a text label.
 */

const IST = 'Asia/Kolkata';
export const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-GB', { timeZone: IST, ...opts });
/** IST calendar day `daysAgo` days back, YYYY-MM-DD. */
export const istDay = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString('en-CA', { timeZone: IST });

/** Round the largest value up to a clean axis top and give 4 even ticks (0 included). */
function axis(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return Array.from({ length: 5 }, (_, i) => +(i * step).toFixed(6));
}

const fmtTick = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : String(+v.toFixed(1)));

interface DayRow {
  date: string;
}

/** Shared frame: y ticks + hairline grid, one column per day, x labels on a sparse cadence, a hover/focus tooltip. */
function ColumnChart<T extends DayRow>({
  rows,
  ticks,
  column,
  tooltip,
  label,
  xLabel = (d) => dayLabel(d.date, { day: 'numeric', month: 'short' }),
  title = (d) => dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' }),
}: {
  rows: T[];
  ticks: number[];
  column: (d: T, scale: (v: number) => number) => ReactNode;
  tooltip: (d: T) => ReactNode;
  label: (d: T) => string;
  /** Axis label and tooltip title of a column (default: the IST day). */
  xLabel?: (d: T) => string;
  title?: (d: T) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const top = ticks[ticks.length - 1];
  const scale = (v: number) => (v / top) * 100;
  const every = Math.max(1, Math.ceil(rows.length / 8));
  return (
    <div className="relative">
      <div className="flex" style={{ height: 184 }}>
        <div className="relative w-10 shrink-0 text-right text-xs text-muted tabular-nums" aria-hidden>
          {ticks.map((v) => (
            <span key={v} className="absolute right-2" style={{ bottom: `${scale(v)}%`, transform: 'translateY(50%)' }}>
              {fmtTick(v)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-border" style={{ bottom: `${scale(v)}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end">
            {rows.map((d, i) => (
              <div
                key={d.date}
                tabIndex={0}
                role="img"
                aria-label={label(d)}
                className="flex h-full flex-1 cursor-default items-end justify-center outline-none focus-visible:bg-surface-2"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <div className={cn('flex h-full w-full max-w-6 flex-col justify-end px-px transition-opacity', hover !== null && hover !== i && 'opacity-60')}>{column(d, scale)}</div>
              </div>
            ))}
          </div>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-max max-w-56 -translate-x-1/2 rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-md"
              style={{ left: `${Math.min(88, Math.max(12, ((hover + 0.5) / rows.length) * 100))}%` }}
            >
              <p className="font-semibold">{title(rows[hover])}</p>
              {tooltip(rows[hover])}
            </div>
          )}
        </div>
      </div>
      <div className="ml-10 flex text-xs text-muted" aria-hidden>
        {rows.map((d, i) => (
          <span key={d.date} className="relative h-5 flex-1">
            {/* Phones show every other label, so they never run into each other. */}
            {i % every === 0 && (
              <span className={cn('absolute top-1 left-1/2 -translate-x-1/2 whitespace-nowrap', i % (every * 2) !== 0 && 'max-sm:hidden')}>{xLabel(d)}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function TableToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={on} className="ml-auto rounded px-1.5 py-0.5 text-sm font-medium text-accent-text hover:underline">
      {on ? 'Show chart' : 'Show table'}
    </button>
  );
}

function DayTable<T extends DayRow>({ rows, cols, first = 'Date', name = (d) => dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' }) }: { rows: T[]; cols: { label: string; value: (d: T) => string }[]; first?: string; name?: (d: T) => string }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface text-left text-muted">
          <tr>
            <th className="py-2 font-medium">{first}</th>
            {cols.map((c) => (
              <th key={c.label} className="py-2 text-right font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((d) => (
            <tr key={d.date} className="border-t border-border">
              <td className="py-2">{name(d)}</td>
              {cols.map((c) => (
                <td key={c.label} className="py-2 text-right tabular-nums">
                  {c.value(d)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string; value?: ReactNode }[] }) {
  return (
    <>
      {items.map((r) => (
        <span key={r.label} className="inline-flex items-center gap-1.5">
          <span className="size-3 rounded-sm" style={{ background: r.color }} aria-hidden />
          {r.label}
          {r.value !== undefined && <span className="font-semibold text-fg tabular-nums">{r.value}</span>}
        </span>
      ))}
    </>
  );
}

// ── missions per day (stacked by result) ───────────────────────────────────

export const RESULTS = [
  { key: 'completed', label: 'Completed', color: 'var(--chart-good)' },
  { key: 'aborted', label: 'Aborted', color: 'var(--chart-warning)' },
  { key: 'failed', label: 'Failed', color: 'var(--chart-critical)' },
] as const;

type MissionDay = DayRow & { completed: number; aborted: number; failed: number };

/** Axis label and tooltip title of a time bucket: an IST hour (ISO), a day (YYYY-MM-DD) or a month (YYYY-MM). */
export function bucketLabels(granularity: 'hour' | 'day' | 'month') {
  if (granularity === 'hour') return { x: (d: DayRow) => hourLabel(d.date), title: (d: DayRow) => hourTitle(d.date), first: 'Hour' };
  if (granularity === 'month') {
    const m = (d: DayRow, opts: Intl.DateTimeFormatOptions) => new Date(`${d.date}-15T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
    return { x: (d: DayRow) => m(d, { month: 'short', year: '2-digit' }), title: (d: DayRow) => m(d, { month: 'long', year: 'numeric' }), first: 'Month' };
  }
  return { x: (d: DayRow) => dayLabel(d.date, { day: 'numeric', month: 'short' }), title: (d: DayRow) => dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' }), first: 'Date' };
}

/** `granularity`: the rows are hours or months instead of days. */
export function MissionsPerDayChart({ rows, granularity = 'day' }: { rows: MissionDay[]; granularity?: 'hour' | 'day' | 'month' }) {
  const lb = bucketLabels(granularity);
  const [table, setTable] = useState(false);
  const ticks = axis(Math.max(...rows.map((d) => d.completed + d.aborted + d.failed)));
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted">
        <Legend items={RESULTS.map((r) => ({ label: r.label, color: r.color }))} />
        <TableToggle on={table} onToggle={() => setTable((x) => !x)} />
      </div>
      {table ? (
        <DayTable
          rows={rows}
          first={lb.first}
          name={lb.title}
          cols={[...RESULTS.map((r) => ({ label: r.label, value: (d: MissionDay) => String(d[r.key]) })), { label: 'Total', value: (d: MissionDay) => String(d.completed + d.aborted + d.failed) }]}
        />
      ) : (
        <ColumnChart
          rows={rows}
          ticks={ticks}
          label={(d) => `${lb.title(d)}: ${d.completed} completed, ${d.aborted} aborted, ${d.failed} failed`}
          xLabel={lb.x}
          title={lb.title}
          tooltip={(d) => (
            <ul className="mt-1">
              {RESULTS.map((r) => (
                <li key={r.key} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm" style={{ background: r.color }} aria-hidden />
                  {r.label} <span className="ml-auto pl-4 font-semibold tabular-nums">{d[r.key]}</span>
                </li>
              ))}
            </ul>
          )}
          column={(d, scale) =>
            // Stacked from the baseline: completed at the bottom; 2px surface gap between segments; only the top one is rounded.
            RESULTS.filter((r) => d[r.key] > 0)
              .slice()
              .reverse()
              .map((r, i) => (
                <div
                  key={r.key}
                  className={cn('w-full', i === 0 && 'rounded-t-[4px]', i > 0 && 'border-t-2 border-surface')}
                  style={{ height: `${scale(d[r.key])}%`, background: r.color, boxSizing: 'border-box' }}
                />
              ))
          }
        />
      )}
    </>
  );
}

// ── distance per day (one series) ──────────────────────────────────────────

type DistanceDay = DayRow & { driven_m: number };

export function DistancePerDayChart({ rows, note }: { rows: DistanceDay[]; note?: string }) {
  const [table, setTable] = useState(false);
  const km = (d: DistanceDay) => d.driven_m / 1000;
  const ticks = axis(Math.max(...rows.map(km)));
  return (
    <>
      <div className="mb-4 flex items-center text-sm text-muted">
        <span>{note ?? 'Kilometres driven each day'}</span>
        <TableToggle on={table} onToggle={() => setTable((x) => !x)} />
      </div>
      {table ? (
        <DayTable rows={rows} cols={[{ label: 'Distance driven', value: (d) => fmtDistance(d.driven_m) }]} />
      ) : (
        <ColumnChart
          rows={rows}
          ticks={ticks}
          label={(d) => `${dayLabel(d.date, { day: 'numeric', month: 'short' })}: ${fmtDistance(d.driven_m)} driven`}
          tooltip={(d) => <p className="mt-1">{fmtDistance(d.driven_m)} driven</p>}
          column={(d, scale) => (d.driven_m > 0 ? <div className="w-full rounded-t-[4px]" style={{ height: `${scale(km(d))}%`, background: 'var(--accent)' }} /> : null)}
        />
      )}
    </>
  );
}

// ── part-to-whole: one horizontal stacked bar ──────────────────────────────

/** One bar split into parts (e.g. robots online / stale / offline), with a legend that carries the numbers. */
/** `large`: bigger legend text, for a headline bar (the dashboard band). */
export function ShareBar({ parts, label, large }: { parts: { label: string; value: number; color: string }[]; label: string; large?: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  const pct = (v: number) => (total ? Math.round((v / total) * 100) : 0);
  return (
    <div>
      <div className="relative flex h-6 w-full gap-[2px] overflow-visible" role="img" aria-label={`${label}: ${parts.map((p) => `${p.value} ${p.label.toLowerCase()}`).join(', ')}`}>
        {total === 0 ? (
          <div className="h-full w-full rounded-[4px] bg-surface-2" />
        ) : (
          shown.map((p, i) => (
            <div
              key={p.label}
              className={cn('relative h-full transition-opacity', i === 0 && 'rounded-l-[4px]', i === shown.length - 1 && 'rounded-r-[4px]', hover && hover !== p.label && 'opacity-60')}
              style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
              onMouseEnter={() => setHover(p.label)}
              onMouseLeave={() => setHover(null)}
            >
              {hover === p.label && (
                <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max -translate-x-1/2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-fg shadow-md">
                  <span className="font-semibold">{p.label}</span> {p.value} ({pct(p.value)} %)
                </span>
              )}
            </div>
          ))
        )}
      </div>
      <div className={cn('mt-3 flex flex-wrap gap-x-5 gap-y-1 text-muted', large ? 'text-base' : 'text-sm')}>
        <Legend items={parts.map((p) => ({ label: p.label, color: p.color, value: p.value }))} />
      </div>
    </div>
  );
}

// ── compare magnitude across items: horizontal bars, largest first ─────────

/**
 * One bar per item (e.g. missions per robot), one hue, value at the bar's tip, `detail` on hover.
 * `scaleMax` fixes the scale for bounded values (battery: 100); otherwise the largest value sets it.
 */
export function RankBars({
  rows,
  empty,
  scaleMax,
}: {
  rows: { key: string; label: ReactNode; value: number; display: string; detail?: string }[];
  empty?: string;
  scaleMax?: number;
}) {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const largest = Math.max(0, ...sorted.map((r) => r.value));
  if (largest === 0) return <p className="text-sm text-muted">{empty ?? 'Nothing recorded in this period.'}</p>;
  const max = scaleMax ?? largest;
  return (
    <ul className="flex flex-col gap-3">
      {sorted.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-3" title={r.detail ?? r.display}>
          <span className="truncate font-mono text-sm">{r.label}</span>
          {/* The bar keeps its true length (longest = 70 % of the track); the value sits at its tip and never squeezes it. */}
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-5 shrink-0 rounded-r-[4px]" style={{ width: `${r.value > 0 ? Math.max(1, (r.value / max) * 70) : 0}%`, background: 'var(--accent)' }} aria-hidden />
            <span className="text-sm font-semibold whitespace-nowrap tabular-nums">{r.display}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── part-to-whole as a ring (robot status) ─────────────────────────────────

/**
 * A donut: parts around a ring with a 2px surface gap between them, the total (or `center`) in the middle,
 * a hover tooltip per part and a legend that carries the numbers, so no part is told apart by colour alone.
 */
export function Donut({ parts, label, center, sub, size = 168 }: { parts: { label: string; value: number; color: string }[]; label: string; center?: ReactNode; sub?: string; size?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  const shown = parts.filter((p) => p.value > 0);
  const gap = shown.length > 1 ? 1.6 : 0;
  let offset = 0;
  const h = parts.find((p) => p.label === hover);
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" role="img" aria-label={`${label}: ${parts.map((p) => `${p.value} ${p.label.toLowerCase()}`).join(', ')}`}>
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="12" />
          {total > 0 &&
            shown.map((p) => {
              const len = (p.value / total) * c;
              const dash = Math.max(0.5, len - gap);
              const el = (
                <circle
                  key={p.label}
                  cx="50"
                  cy="50"
                  r={r}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={hover === p.label ? 14 : 12}
                  strokeDasharray={`${dash} ${c - dash}`}
                  strokeDashoffset={-offset}
                  className={cn('cursor-default transition-opacity', hover && hover !== p.label && 'opacity-50')}
                  onMouseEnter={() => setHover(p.label)}
                  onMouseLeave={() => setHover(null)}
                />
              );
              offset += len;
              return el;
            })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center" aria-hidden>
          <span className="text-4xl leading-none font-semibold tabular-nums">{h ? h.value : (center ?? total)}</span>
          <span className="mt-1 text-sm text-muted">{h ? h.label : (sub ?? 'total')}</span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-col gap-2 text-base">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-2.5" onMouseEnter={() => setHover(p.label)} onMouseLeave={() => setHover(null)}>
            <span className="size-3.5 shrink-0 rounded-sm" style={{ background: p.color }} aria-hidden />
            <span className="text-muted">{p.label}</span>
            <span className="ml-auto pl-4 font-semibold tabular-nums">{p.value}</span>
            <span className="w-12 text-right text-sm text-muted tabular-nums">{total ? `${Math.round((p.value / total) * 100)} %` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── distance / time per day, stacked by robot category ─────────────────────

export const CATEGORIES: { key: RobotCategory; label: string; color: string; time: string }[] = [
  { key: 'ugv', label: 'UGV', color: 'var(--cat-ugv)', time: 'Drive time' },
  { key: 'uav', label: 'UAV', color: 'var(--cat-uav)', time: 'Flight time' },
];

type CategoryDay = DayRow & { by_category: Record<RobotCategory, { driven_m: number; moving_s: number }> };

/**
 * Per day, UGV and UAV stacked (UGV at the base): kilometres travelled, or hours moving (UGV driving, UAV flight).
 * Legend carries each category's total for the period; hover a day for its numbers; table view included.
 */
/** IST hour of an hourly row's key (2026-10-29T14:00:00+05:30) as "2 pm", and with its day for tooltips. */
const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', hour12: true });
const hourTitle = (iso: string) =>
  `${new Date(iso).toLocaleDateString('en-GB', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' })}, ${hourLabel(iso)}–${hourLabel(new Date(new Date(iso).getTime() + 3_600_000).toISOString())}`;

/** `hourly`: rows are IST hours (date = hour start) instead of days; values are then per hour. */
export function CategoryPerDayChart({ rows, metric, hourly }: { rows: CategoryDay[]; metric: 'distance' | 'time'; hourly?: boolean }) {
  const [table, setTable] = useState(false);
  // Per hour the bars are small: metres and minutes read better than kilometres and hours.
  const v = (d: CategoryDay, k: RobotCategory) =>
    metric === 'distance' ? d.by_category[k].driven_m / (hourly ? 1 : 1000) : d.by_category[k].moving_s / (hourly ? 60 : 3600);
  const show = (d: CategoryDay, k: RobotCategory) => (metric === 'distance' ? fmtDistance(d.by_category[k].driven_m) : fmtDuration(d.by_category[k].moving_s));
  const ticks = axis(Math.max(...rows.map((d) => v(d, 'ugv') + v(d, 'uav'))));
  const totals = CATEGORIES.map((c) => {
    const sum = rows.reduce((s, d) => s + (metric === 'distance' ? d.by_category[c.key].driven_m : d.by_category[c.key].moving_s), 0);
    return { ...c, value: metric === 'distance' ? fmtDistance(sum) : fmtDuration(sum) };
  });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted">
        <span>{metric === 'distance' ? (hourly ? 'Metres per hour' : 'Kilometres per day') : hourly ? 'Minutes moving per hour' : 'Hours moving per day'}</span>
        <Legend items={totals.map((c) => ({ label: metric === 'time' ? `${c.label} ${c.time.toLowerCase()}` : c.label, color: c.color, value: c.value }))} />
        <TableToggle on={table} onToggle={() => setTable((x) => !x)} />
      </div>
      {table ? (
        <DayTable
          rows={rows}
          first={hourly ? 'Hour' : 'Date'}
          name={hourly ? (d) => hourTitle(d.date) : undefined}
          cols={CATEGORIES.map((c) => ({ label: metric === 'time' ? `${c.label} ${c.time.toLowerCase()}` : `${c.label} distance`, value: (d: CategoryDay) => show(d, c.key) }))}
        />
      ) : (
        <ColumnChart
          rows={rows}
          ticks={ticks}
          label={(d) => `${hourly ? hourTitle(d.date) : dayLabel(d.date, { day: 'numeric', month: 'short' })}: ${CATEGORIES.map((c) => `${c.label} ${show(d, c.key)}`).join(', ')}`}
          xLabel={hourly ? (d) => hourLabel(d.date) : undefined}
          title={hourly ? (d) => hourTitle(d.date) : undefined}
          tooltip={(d) => (
            <ul className="mt-1">
              {CATEGORIES.map((c) => (
                <li key={c.key} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm" style={{ background: c.color }} aria-hidden />
                  {metric === 'time' ? c.time : c.label} <span className="ml-auto pl-4 font-semibold tabular-nums">{show(d, c.key)}</span>
                </li>
              ))}
            </ul>
          )}
          column={(d, scale) =>
            CATEGORIES.filter((c) => v(d, c.key) > 0)
              .slice()
              .reverse()
              .map((c, i) => (
                <div key={c.key} className={cn('w-full', i === 0 && 'rounded-t-[4px]', i > 0 && 'border-t-2 border-surface')} style={{ height: `${scale(v(d, c.key))}%`, background: c.color, boxSizing: 'border-box' }} />
              ))
          }
        />
      )}
    </>
  );
}
