'use client';

import type { DashboardDto, FleetHourlyDto, StorageFileType, StorageUsageDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { axis, CATEGORIES, dayLabel, Donut, fmtTick, RankBars } from '@/components/domain/charts';
import { useDashboard, useFleetReport } from '@/components/domain/dashboard';
import { OptionFilter } from '@/components/ui/filter-menu';
import { Card, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { periodBounds } from '@/lib/periods';

/** The fleet at a glance, mostly as charts. The status ring opens the Robots page with that status filtered. */
export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const q = useDashboard();
  const can = useCan();
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        {can('robot.write') && (
          <Link href="/robots/new" className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-3 text-base font-medium text-accent-fg hover:opacity-90">
            <Plus className="size-4" aria-hidden /> Register robot
          </Link>
        )}
      </div>
      <QueryView query={q} rows={8}>
        {(d) => <FleetView d={d} />}
      </QueryView>
    </>
  );
}

function More({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
      {children} <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

// ── robots ──────────────────────────────────────────────────────────────────

const categoryColor = (c: string) => CATEGORIES.find((x) => x.key === c)?.color;

/** The fleet's status, large and clickable, beside the storage used on AWS (staff) or what the fleet is made of; below, drive and flight time, each on its own. */
function FleetView({ d }: { d: DashboardDto }) {
  const can = useCan();
  const [period, setPeriod] = useState<DashboardPeriod>('all');
  const linked = { period, onPeriod: setPeriod };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <StatusCard d={d} />
        {can('system.read') ? <StorageTile {...linked} /> : <ModelsTile d={d} />}
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <TrendTile {...linked} title="Drive time" category="ugv" metric="moving_s" format={fmtDuration} />
        <TrendTile {...linked} title="Flight time" category="uav" metric="moving_s" format={fmtDuration} />
      </div>
    </div>
  );
}

function Tile({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm', className)}>
      <h2 className="mb-2 text-sm text-muted">{title}</h2>
      {children}
    </section>
  );
}

/** How much of the fleet is reporting. A click on a part of the ring or its line opens those robots. */
function StatusCard({ d }: { d: DashboardDto }) {
  const pct = d.robots_total ? Math.round((d.by_status.online / d.robots_total) * 100) : 0;
  return (
    <Card title="Fleet status" actions={<More href="/robots">All {d.robots_total} robots</More>} className="flex min-w-0 flex-col" bodyClassName="flex flex-1 items-center justify-center p-6 [&>div]:justify-center">
      <Donut
        label="Robots by status"
        size={260}
        center={`${pct}%`}
        sub="online"
        hrefFor={(label) => `/robots?status=${label.toLowerCase()}`}
        parts={[
          { label: 'Online', value: d.by_status.online, color: 'var(--chart-good)' },
          { label: 'Offline', value: d.by_status.offline, color: 'var(--chart-neutral)' },
        ]}
      />
    </Card>
  );
}

/** What the fleet is made of: robots per base model, coloured by UGV or UAV. */
function ModelsTile({ d }: { d: DashboardDto }) {
  const by = new Map<string, { name: string; category: string; n: number }>();
  for (const r of d.fleet) {
    const x = by.get(r.product_name) ?? { name: r.product_name, category: r.category, n: 0 };
    x.n += 1;
    by.set(r.product_name, x);
  }
  return (
    <Tile title={`${d.robots_total} robots · ${d.by_category.ugv.robots} UGV · ${d.by_category.uav.robots} UAV`}>
      <RankBars
        empty="No robots registered yet."
        rows={[...by.values()].slice(0, 4).map((x) => ({ key: x.name, label: <span className="font-sans">{x.name}</span>, value: x.n, display: String(x.n), color: categoryColor(x.category), detail: `${x.name}: ${x.n} ${x.category.toUpperCase()} robot(s)` }))}
      />
    </Tile>
  );
}

/** One time range for the storage and trend boxes: changing any Filter changes them all. */
const DASHBOARD_PERIODS = [
  { id: 'all', label: 'All time', title: 'all time' },
  { id: '1d', label: '1 day', title: 'last 24 hours', days: 1 },
  { id: '7d', label: '7 days', title: 'last 7 days', days: 7 },
  { id: '30d', label: '30 days', title: 'last 30 days', days: 30 },
  { id: '90d', label: '3 months', title: 'last 3 months', days: 90 },
] as const;
type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]['id'];
/** The longest range the fleet report answers. */
const MAX_REPORT_DAYS = 92;
/** A graph needs two days to draw a line, so the 1 day range shows the last two. */
const lastDays = <T,>(rows: T[], days: number | null) => (days ? rows.slice(-Math.max(days, 2)) : rows);
const GB = 1024 ** 3;

/** How much is filled on AWS: the total and how it grew, or with More insights, what the space is used for. */
function StorageTile({ period, onPeriod }: { period: DashboardPeriod; onPeriod: (p: DashboardPeriod) => void }) {
  const [insights, setInsights] = useState(false);
  const chosen = DASHBOARD_PERIODS.find((p) => p.id === period)!;
  const q = useQuery({ queryKey: ['storage-usage'], queryFn: () => api.get<StorageUsageDto>('/system/storage'), staleTime: 600_000 });
  const daily = q.data?.daily ?? [];
  const shown = lastDays(daily, 'days' in chosen ? chosen.days : null);
  const rows: TrendRow[] = shown.map((x) => ({ key: x.date, value: x.total_bytes, tick: dayLabel(x.date, { day: 'numeric', month: 'short' }), when: dayLabel(x.date, { weekday: 'short', day: 'numeric', month: 'short' }) }));
  const added = shown.reduce((s, x) => s + x.added_bytes, 0);
  const top = Math.max(0, ...rows.map((r) => r.value));
  const unit = top > 0 && top < GB ? { name: 'MB', factor: 1 / 1024 ** 2 } : { name: 'GB', factor: 1 / GB };
  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm text-muted">Storage on AWS · {insights ? `by type · ${chosen.title}` : chosen.title}</h2>
        <div className="flex items-center gap-2">
          <OptionFilter label="Storage" value={period} options={DASHBOARD_PERIODS} onChange={onPeriod} />
          {q.data && (
            <button type="button" onClick={() => setInsights(!insights)} className="w-28 rounded-md border border-border bg-surface py-1 text-sm hover:bg-surface-2">
              {insights ? 'Back' : 'More insights'}
            </button>
          )}
        </div>
      </div>
      <p className="mb-1 text-3xl leading-none font-semibold tabular-nums">{q.data ? fmtBytes(q.data.total_bytes) : q.isError ? '–' : '…'}</p>
      {q.isError && <p className="text-sm text-muted">Could not read the storage from AWS.</p>}
      {/* Both views share one space, so switching never changes the size of this box or the ones beside it. */}
      {q.data && (
        <div className="grid">
        <div className={cn('[grid-area:1/1] min-w-0', insights && 'invisible')}>
          <p className="mb-2 text-sm text-muted">
            S3 files {fmtBytes(q.data.files_bytes)} · Database {fmtBytes(q.data.database_bytes)} · {fmtBytes(added)} added in this period
          </p>
          <TrendChart rows={rows} label="S3 files filled" per="day" format={fmtBytes} color="var(--accent)" unit={unit} />
        </div>
        <div className={cn('[grid-area:1/1] min-w-0', !insights && 'invisible')}>
          <StorageTypesChart usage={q.data} days={'days' in chosen ? chosen.days : null} />
        </div>
        </div>
      )}
    </section>
  );
}

/**
 * Every type of file on one graph with one scale, like the other graphs. Videos are far larger than the rest, so a click
 * on a name in the legend hides that line and the scale adjusts to what is left.
 */
function StorageTypesChart({ usage, days, height = 170 }: { usage: StorageUsageDto; days: number | null; height?: number }) {
  const [hidden, setHidden] = useState<StorageFileType[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const allDays = useMemo(() => {
    const totals: Partial<Record<StorageFileType, number>> = {};
    return usage.daily.map((d) => {
      for (const [type, added] of Object.entries(d.added_by_type)) totals[type as StorageFileType] = (totals[type as StorageFileType] ?? 0) + (added ?? 0);
      return { date: d.date, totals: { ...totals } };
    });
  }, [usage.daily]);
  const shown = lastDays(allDays, days);
  const visible = usage.types.filter((t) => !hidden.includes(t.key));
  const top = Math.max(0, ...visible.flatMap((t) => shown.map((d) => d.totals[t.key] ?? 0)));
  const unit = top > 0 && top < GB ? { name: 'MB', factor: 1 / 1024 ** 2 } : { name: 'GB', factor: 1 / GB };
  const ticks = axis(top * unit.factor);
  const ceiling = ticks[ticks.length - 1] || 1;
  const x = (i: number) => (shown.length > 1 ? (i / (shown.length - 1)) * 100 : 0);
  const y = (bytes: number) => 100 - ((bytes * unit.factor) / ceiling) * 100;
  const every = Math.max(1, Math.ceil(shown.length / 7));
  const h = hover === null ? null : shown[Math.min(hover, shown.length - 1)];
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(shown.length - 1, Math.round(((e.clientX - b.left) / b.width) * (shown.length - 1)))));
  };
  return (
    <div>
      <p className="mb-2 text-sm text-muted">{unit.name}</p>
      <div className="flex" style={{ height }}>
        <div className="relative w-10 shrink-0 text-sm text-muted tabular-nums" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 -translate-y-1/2" style={{ top: `${100 - (t / ceiling) * 100}%` }}>
              {fmtTick(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 cursor-crosshair" onMouseMove={pick} onMouseLeave={() => setHover(null)} role="img" aria-label={`Storage by type over time, in ${unit.name}: ${visible.map((t) => `${t.label} ${fmtBytes(t.bytes)}`).join(', ')}.`}>
          {ticks.map((t) => (
            <span key={t} className="absolute inset-x-0 border-t border-border" style={{ top: `${100 - (t / ceiling) * 100}%` }} aria-hidden />
          ))}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
            {visible.map((t) => (
              <polyline key={t.key} points={shown.map((d, i) => `${x(i)},${y(d.totals[t.key] ?? 0)}`).join(' ')} fill="none" stroke={`var(--store-${t.key})`} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          {h && hover !== null && (
            <>
              <span className="pointer-events-none absolute inset-y-0 border-l border-muted/50" style={{ left: `${x(hover)}%` }} aria-hidden />
              {visible.map((t) => (
                <span key={t.key} className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface" style={{ left: `${x(hover)}%`, top: `${y(h.totals[t.key] ?? 0)}%`, background: `var(--store-${t.key})` }} aria-hidden />
              ))}
              <span className={cn('pointer-events-none absolute top-1 z-10 w-max rounded-md border border-border bg-surface px-3 py-1.5 text-sm shadow-lg', x(hover) > 55 ? '-ml-3 -translate-x-full' : 'ml-3')} style={{ left: `${x(hover)}%` }}>
                <span className="mb-0.5 block text-muted">{dayLabel(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                {[...visible]
                  .sort((a, b) => (h.totals[b.key] ?? 0) - (h.totals[a.key] ?? 0))
                  .map((t) => (
                    <span key={t.key} className="flex items-center gap-1.5">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: `var(--store-${t.key})` }} aria-hidden />
                      {t.label} <span className="ml-auto pl-3 font-semibold tabular-nums">{fmtBytes(h.totals[t.key] ?? 0)}</span>
                    </span>
                  ))}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="relative mt-1 ml-10 h-6 text-sm text-muted" aria-hidden>
        {shown.map((d, i) =>
          i % every === 0 ? (
            <span key={d.date} className={cn('absolute whitespace-nowrap', i > 0 && (x(i) > 92 ? '-translate-x-full' : '-translate-x-1/2'))} style={{ left: `${x(i)}%` }}>
              {dayLabel(d.date, { day: 'numeric', month: 'short' })}
            </span>
          ) : null,
        )}
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
        {usage.types.map((t) => {
          const off = hidden.includes(t.key);
          return (
            <li key={t.key}>
              <button type="button" aria-pressed={!off} onClick={() => setHidden(off ? hidden.filter((k) => k !== t.key) : [...hidden, t.key])} title={`${t.files.toLocaleString('en-IN')} files. Click to ${off ? 'show' : 'hide'}.`} className={cn('inline-flex items-center gap-1.5 rounded px-1 hover:bg-surface-2', off && 'text-muted line-through')}>
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: off ? 'var(--border)' : `var(--store-${t.key})` }} aria-hidden />
                {t.label} <span className="tabular-nums">{fmtBytes(t.bytes)}</span>
              </button>
            </li>
          );
        })}
        <li className="px-1 text-muted" title="Its history is not recorded, so it has no line">
          Database {fmtBytes(usage.database_bytes)}
        </li>
      </ul>
    </div>
  );
}

/** Plot in units that read simply: km or m, hours or minutes, chosen by the largest day. Tooltips show the exact value. */
function axisUnit(metric: 'driven_m' | 'moving_s', max: number) {
  if (metric === 'driven_m') return max > 0 && max < 1000 ? { name: 'metres', factor: 1 } : { name: 'km', factor: 1 / 1000 };
  return max > 0 && max < 3600 ? { name: 'minutes', factor: 1 / 60 } : { name: 'hours', factor: 1 / 3600 };
}

const istHour = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/**
 * One measure for one kind of robot, never merged: UGVs drive and UAVs fly. The total and a chart with its own period:
 * per hour for 1 day, per day for the longer ones. Hover for any point.
 */
function TrendTile({ title, category, metric, format, period, onPeriod }: { title: string; category: 'ugv' | 'uav'; metric: 'driven_m' | 'moving_s'; format: (v: number) => string; period: DashboardPeriod; onPeriod: (p: DashboardPeriod) => void }) {
  const hourly = period === '1d';
  const chosen = DASHBOARD_PERIODS.find((p) => p.id === period)!;
  const allTime = !('days' in chosen);
  const daily = useFleetReport('days' in chosen ? chosen.days : MAX_REPORT_DAYS, !hourly);
  // The 24 hour window is fixed when the period is picked and moves on every 5 minutes, not on every render.
  const [bounds, setBounds] = useState(() => periodBounds('24h'));
  useEffect(() => {
    if (!hourly) return;
    setBounds(periodBounds('24h'));
    const t = window.setInterval(() => setBounds(periodBounds('24h')), 300_000);
    return () => window.clearInterval(t);
  }, [hourly]);
  const hours = useQuery({
    queryKey: ['fleet-hourly', bounds.from, bounds.to],
    queryFn: () => api.get<FleetHourlyDto>('/reports/fleet/hourly', { from: bounds.from!, to: bounds.to! }),
    enabled: hourly && !!bounds.from,
    placeholderData: keepPreviousData,
    staleTime: 120_000,
  });
  const loaded = hourly ? !!hours.data : !!daily.data;
  const allRows: TrendRow[] = hourly
    ? (hours.data?.hours ?? []).map((h) => ({ key: h.hour, value: h.by_category[category][metric], tick: istHour(h.hour), when: `${dayLabel(new Date(h.hour).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), { day: 'numeric', month: 'short' })}, ${istHour(h.hour)}` }))
    : (daily.data?.daily ?? []).map((x) => ({ key: x.date, value: x.by_category[category][metric], tick: dayLabel(x.date, { day: 'numeric', month: 'short' }), when: dayLabel(x.date, { weekday: 'short', day: 'numeric', month: 'short' }) }));
  // All time starts at the first activity, not at the far end of the longest range.
  const firstActive = allTime ? allRows.findIndex((r) => r.value > 0) : 0;
  const rows = firstActive > 0 ? allRows.slice(Math.min(firstActive, allRows.length - 2)) : allRows;
  const total = rows.reduce((s, x) => s + x.value, 0);
  const unit = axisUnit(metric, Math.max(0, ...rows.map((r) => r.value)));
  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm text-muted">
          {title} · {allTime ? 'last 3 months' : chosen.title}
        </h2>
        <OptionFilter label={title} value={period} options={DASHBOARD_PERIODS} onChange={onPeriod} />
      </div>
      <p className="mb-2 text-3xl leading-none font-semibold tabular-nums">{loaded ? format(total) : '…'}</p>
      <TrendChart rows={rows} label={title} per={hourly ? 'hour' : 'day'} format={format} color={`var(--cat-${category})`} unit={unit} />
    </section>
  );
}

interface TrendRow {
  key: string;
  value: number;
  /** Its label on the time axis, and the fuller one in the tooltip. */
  tick: string;
  when: string;
}

/** An area over time with a value axis (with its unit) and a date axis. Hover shows the day and its exact value. */
function TrendChart({ rows, label, per, format, color, unit, height = 220 }: { rows: TrendRow[]; label: string; per: string; format: (v: number) => string; color: string; unit: { name: string; factor: number }; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const fillId = useId();
  if (rows.length < 2) return <div style={{ height: height + 44 }} />;
  const ticks = axis(Math.max(0, ...rows.map((r) => r.value * unit.factor)));
  const top = ticks[ticks.length - 1];
  const x = (i: number) => (i / (rows.length - 1)) * 100;
  const y = (v: number) => 100 - ((v * unit.factor) / top) * 100;
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)} ${y(r.value)}`).join(' ');
  const every = Math.max(1, Math.ceil(rows.length / 7));
  const h = hover === null ? null : rows[hover];
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(rows.length - 1, Math.round(((e.clientX - b.left) / b.width) * (rows.length - 1)))));
  };
  return (
    <div>
      <p className="mb-2 text-sm text-muted">{unit.name}</p>
      <div className="flex" style={{ height }}>
        <div className="relative w-10 shrink-0 text-sm text-muted tabular-nums" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 -translate-y-1/2" style={{ top: `${100 - (t / top) * 100}%` }}>
              {fmtTick(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 cursor-crosshair" onMouseMove={pick} onMouseLeave={() => setHover(null)} role="img" aria-label={`${label} per ${per}, ${rows.length} points, in ${unit.name}. Highest ${format(Math.max(...rows.map((r) => r.value)))}.`}>
          {ticks.map((t) => (
            <span key={t} className="absolute inset-x-0 border-t border-border" style={{ top: `${100 - (t / top) * 100}%` }} aria-hidden />
          ))}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.35" />
                <stop offset="100%" stopColor={color} stopOpacity="0.03" />
              </linearGradient>
            </defs>
            <path d={`${line} L100 100 L0 100 Z`} fill={`url(#${fillId})`} />
            <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {h && hover !== null && (
            <>
              <span className="pointer-events-none absolute inset-y-0 border-l border-muted/50" style={{ left: `${x(hover)}%` }} aria-hidden />
              <span className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface" style={{ left: `${x(hover)}%`, top: `${y(h.value)}%`, background: color }} aria-hidden />
              <span className={cn('pointer-events-none absolute top-1 z-10 w-max rounded-md border border-border bg-surface px-3 py-1.5 text-sm shadow-lg', x(hover) > 60 ? '-ml-3 -translate-x-full' : 'ml-3')} style={{ left: `${x(hover)}%` }}>
                <span className="block font-semibold">{format(h.value)}</span>
                <span className="text-muted">{h.when}</span>
              </span>
            </>
          )}
        </div>
      </div>
      <div className="relative mt-1 ml-10 h-6 text-sm text-muted" aria-hidden>
        {rows.map((r, i) =>
          i % every === 0 ? (
            <span key={r.key} className={cn('absolute whitespace-nowrap', i > 0 && (x(i) > 92 ? '-translate-x-full' : '-translate-x-1/2'))} style={{ left: `${x(i)}%` }}>
              {r.tick}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
