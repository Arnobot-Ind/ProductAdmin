'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { fmtDistance } from '@/lib/format';

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
}: {
  rows: T[];
  ticks: number[];
  column: (d: T, scale: (v: number) => number) => ReactNode;
  tooltip: (d: T) => ReactNode;
  label: (d: T) => string;
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
              <p className="font-semibold">{dayLabel(rows[hover].date, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
              {tooltip(rows[hover])}
            </div>
          )}
        </div>
      </div>
      <div className="ml-10 flex text-xs text-muted" aria-hidden>
        {rows.map((d, i) => (
          <span key={d.date} className="relative h-5 flex-1">
            {i % every === 0 && <span className="absolute top-1 left-1/2 -translate-x-1/2 whitespace-nowrap">{dayLabel(d.date, { day: 'numeric', month: 'short' })}</span>}
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

function DayTable<T extends DayRow>({ rows, cols }: { rows: T[]; cols: { label: string; value: (d: T) => string }[] }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface text-left text-muted">
          <tr>
            <th className="py-2 font-medium">Date</th>
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
              <td className="py-2">{dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
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

export function MissionsPerDayChart({ rows }: { rows: MissionDay[] }) {
  const [table, setTable] = useState(false);
  const ticks = axis(Math.max(...rows.map((d) => d.completed + d.aborted + d.failed)));
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted">
        <Legend items={RESULTS.map((r) => ({ label: r.label, color: r.color }))} />
        <TableToggle on={table} onToggle={() => setTable((x) => !x)} />
      </div>
      {table ? (
        <DayTable rows={rows} cols={[...RESULTS.map((r) => ({ label: r.label, value: (d: MissionDay) => String(d[r.key]) })), { label: 'Total', value: (d: MissionDay) => String(d.completed + d.aborted + d.failed) }]} />
      ) : (
        <ColumnChart
          rows={rows}
          ticks={ticks}
          label={(d) => `${dayLabel(d.date, { day: 'numeric', month: 'short' })}: ${d.completed} completed, ${d.aborted} aborted, ${d.failed} failed`}
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
