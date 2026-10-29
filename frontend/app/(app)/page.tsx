'use client';

import type { CategorySummaryDto, DashboardDto, FleetHourlyDto, MissionPeriodStatsDto, RobotCategory } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AlertOctagon, AlertTriangle, ArrowRight, Plane, Plus, Truck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { CATEGORIES, CategoryPerDayChart, Donut, ShareBar } from '@/components/domain/charts';
import { Segmented } from '@/components/ui/segmented';
import { isHourly, periodBounds, periodDays, PERIODS, type PeriodId } from '@/lib/periods';
import { attentionItems, AttentionList, FleetMap, useDashboard, useFleetReport } from '@/components/domain/dashboard';
import { Band } from '@/components/ui/band';
import { Card, QueryView } from '@/components/ui/misc';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtDuration } from '@/lib/format';
import { useDocumentTitle, useNow } from '@/lib/hooks';

const IST = 'Asia/Kolkata';
/** Status = state, so the reserved status tokens, always shown with their label. */
const STATUS = [
  { key: 'online', label: 'Online', color: 'var(--chart-good)' },
  { key: 'stale', label: 'Stale', color: 'var(--chart-warning)' },
  { key: 'offline', label: 'Offline', color: 'var(--chart-neutral)' },
] as const;
const RESULTS = [
  { key: 'completed', label: 'Completed', color: 'var(--chart-good)' },
  { key: 'aborted', label: 'Aborted', color: 'var(--chart-warning)' },
  { key: 'failed', label: 'Failed', color: 'var(--chart-critical)' },
  { key: 'in_progress', label: 'In progress', color: 'var(--accent)' },
] as const;

/**
 * The dashboard shows only what is needed at a glance, in this order:
 *  1. every robot by status (a ring) and the critical errors and warnings open now, with the date and time as one small line;
 *  2. the fleet by category (UGV and UAV), each with its status, faults, missions, distance and time;
 *  3. all missions so far by result;
 *  4. below: distance and drive / flight time per day by category, the needs-action list (short) and a small fleet map.
 * Everything else lives on its own page (side menu).
 */
export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const q = useDashboard();
  return (
    <QueryView query={q} rows={8}>
      {(d) => (
        <div className="flex flex-col gap-8">
          <Overview d={d} />
          <section aria-labelledby="cat-h">
            <SectionTitle id="cat-h" title="By category" href="/robots" link="All robots" />
            <div className="grid gap-5 lg:grid-cols-2">
              {CATEGORIES.map((c) => (
                <CategoryCard key={c.key} category={c.key} s={d.by_category[c.key]} />
              ))}
            </div>
          </section>
          <MissionsOverall />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
            <Travel />
            <section aria-labelledby="attention-h" className="min-w-0">
              <SectionTitle id="attention-h" title="Needs action" href="/overview/attention" link="All items" />
              <AttentionList items={attentionItems(d)} limit={5} compact />
            </section>
          </div>
          <section aria-labelledby="map-h">
            <SectionTitle id="map-h" title="Fleet map" href="/overview/map" link="Full screen" />
            <FleetMap d={d} title="Last known positions" className="h-80" />
          </section>
        </div>
      )}
    </QueryView>
  );
}

// ── 1. date & time, robots by status, critical errors and warnings ─────────

/** Today's date and the time (IST, to the minute), as one small line: there when needed, never in the way. */
function DateTime() {
  const now = useNow(30_000);
  const date = new Date(now).toLocaleDateString('en-GB', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = new Date(now).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true });
  return (
    <p className="text-sm text-muted">
      <time dateTime={new Date(now).toISOString()}>
        {date} · {time} IST
      </time>
    </p>
  );
}

function Overview({ d }: { d: DashboardDto }) {
  const can = useCan();
  const critical = d.active_faults.filter((f) => f.severity === 'critical').length;
  const warnings = d.active_faults.length - critical;
  return (
    <Band labelledBy="hero-h">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3 sm:px-8">
        <h1 id="hero-h" className="text-lg font-semibold">
          Fleet overview
        </h1>
        <div className="flex flex-wrap items-center gap-4">
          <DateTime />
          {can('robot.write') && (
            <Link href="/robots/new" className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg hover:opacity-90">
              <Plus className="size-4" aria-hidden /> Register robot
            </Link>
          )}
        </div>
      </div>
      <div className="grid gap-8 p-6 sm:p-8 xl:grid-cols-[auto_minmax(0,1fr)] xl:items-center">
        <div className="min-w-0 xl:border-r xl:border-border xl:pr-10">
          <h2 className="mb-3 text-base font-semibold">Total robots</h2>
          <Donut label="Robots by status" sub={`robot${d.robots_total === 1 ? '' : 's'}`} parts={STATUS.map((s) => ({ label: s.label, value: d.by_status[s.key], color: s.color }))} />
        </div>

        <div className="min-w-0">
          <h2 className="mb-3 text-base font-semibold">Critical errors &amp; warnings</h2>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Alarm
              href="/overview/attention"
              label="Critical errors"
              value={critical}
              sub="happening now"
              tone="fault"
              title="Problems still going on: the robot reported them and has not reported them cleared yet."
            />
            <Alarm href="/overview/attention" label="Warnings" value={warnings} sub="happening now" tone="warn" title="Warnings still going on (not reported cleared yet)." />
            <Alarm
              href="/overview/attention"
              label="Critical alerts"
              value={d.unacked_critical_events}
              sub="not seen by anyone yet"
              tone="fault"
              title="Every critical message a robot ever sent that no person has acknowledged, including problems that are already fixed. Acknowledge them on Needs attention."
            />
            <Alarm
              href="/overview/events"
              label="Warning alerts"
              value={d.unacked_warning_events}
              sub="not seen by anyone yet"
              tone="warn"
              title="Warning messages no person has acknowledged yet, including ones already cleared."
            />
          </dl>
        </div>
      </div>
    </Band>
  );
}

function Alarm({ label, value, sub, tone, href, title }: { label: string; value: number; sub: string; tone: 'fault' | 'warn'; href: string; title?: string }) {
  const on = value > 0;
  const Icon = tone === 'fault' ? AlertOctagon : AlertTriangle;
  return (
    <Link href={href} title={title} className={cn('block rounded-xl border p-3 transition-colors hover:border-accent/50', on ? (tone === 'fault' ? 'border-fault/30 bg-fault-bg' : 'border-warn/30 bg-warn-bg') : 'border-border bg-surface')}>
      <dt className="flex items-center gap-1.5 text-base font-medium">
        <Icon className={cn('size-4 shrink-0', on ? (tone === 'fault' ? 'text-fault' : 'text-warn') : 'text-muted')} aria-hidden />
        {label}
      </dt>
      <dd className="mt-1 text-3xl font-semibold tabular-nums">{value.toLocaleString('en-IN')}</dd>
      <dd className="text-sm text-muted">{sub}</dd>
    </Link>
  );
}

// ── 2. by category ──────────────────────────────────────────────────────────

const CATEGORY_INFO: Record<RobotCategory, { name: string; Icon: typeof Truck; time: string }> = {
  ugv: { name: 'Ground robots', Icon: Truck, time: 'Drive time' },
  uav: { name: 'Aerial robots', Icon: Plane, time: 'Flight time' },
};

function CategoryCard({ category, s }: { category: RobotCategory; s: CategorySummaryDto }) {
  const info = CATEGORY_INFO[category];
  const c = CATEGORIES.find((x) => x.key === category)!;
  // Distance and time come from what the robots measured while moving (odometer / wheel speed), last 30 days:
  // mission durations are not used, a mission left open on the robot would count weeks of standing still.
  const report = useFleetReport(30);
  const moved = report.data?.daily.reduce((t, d) => ({ m: t.m + d.by_category[category].driven_m, s: t.s + d.by_category[category].moving_s }), { m: 0, s: 0 });
  return (
    <Link href={`/robots?category=${category}`} className="group flex flex-col gap-5 rounded-2xl border border-border bg-surface p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-xl text-white" style={{ background: c.color }} aria-hidden>
            <info.Icon className="size-6" />
          </span>
          <div>
            <h3 className="text-2xl font-semibold">{c.label}</h3>
            <p className="text-base text-muted">{info.name}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-4xl leading-none font-semibold tabular-nums">{s.robots}</p>
          <p className="mt-1 text-sm text-muted">robot{s.robots === 1 ? '' : 's'}</p>
        </div>
      </div>
      <ShareBar large label={`${c.label} robots by status`} parts={STATUS.map((x) => ({ label: x.label, value: s.by_status[x.key], color: x.color }))} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-4">
        <Fact label="With faults" value={s.with_faults} alert={s.with_faults > 0} />
        <Fact label="Missions" value={s.missions.total.toLocaleString('en-IN')} sub={`${s.missions.completed} completed`} />
        <Fact label="Distance" value={moved ? fmtDistance(moved.m) : '…'} sub="last 30 days" />
        <Fact label={info.time} value={moved ? fmtDuration(moved.s) : '…'} sub="last 30 days" />
      </dl>
      <span className="inline-flex items-center gap-1 text-base font-medium text-accent-text">
        Open {c.label} robots <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
    </Link>
  );
}

function Fact({ label, value, sub, alert }: { label: string; value: ReactNode; sub?: string; alert?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-xl font-semibold tabular-nums', alert && 'text-fault')}>{value}</dd>
      {sub && <dd className="text-sm text-muted">{sub}</dd>}
    </div>
  );
}

// ── 3. all missions ─────────────────────────────────────────────────────────

function MissionsOverall() {
  const [period, setPeriod] = useState<PeriodId>('all');
  const [bounds, setBounds] = useState(() => periodBounds(period));
  useEffect(() => setBounds(periodBounds(period)), [period]);
  const q = useQuery({
    queryKey: ['missions', 'stats', bounds.from, bounds.to],
    queryFn: () => api.get<MissionPeriodStatsDto>('/missions/stats', bounds),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
  const label = PERIODS.find((p) => p.id === period)!.label;
  return (
    <section aria-labelledby="missions-h">
      <SectionTitle id="missions-h" title="Missions" href={`/overview/missions${period === '7d' ? '' : `?period=${period}`}`} link="Mission details" />
      <div className="mb-3">
        <Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS.map((p) => [p.id, p.label] as const)} />
      </div>
      <QueryView query={q} rows={2}>
        {(st) => {
          const m = st.totals;
          return (
            <Card bodyClassName="grid gap-6 p-6 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center">
              <div>
                <p className="text-5xl leading-none font-semibold tabular-nums">{m.total.toLocaleString('en-IN')}</p>
                <p className="mt-1 text-base text-muted">missions · {label.toLowerCase()}</p>
              </div>
              <div className="min-w-0">
                <ShareBar large label={`Missions by result, ${label.toLowerCase()}`} parts={RESULTS.map((r) => ({ label: r.label, value: m[r.key], color: r.color }))} />
              </div>
            </Card>
          );
        }}
      </QueryView>
    </section>
  );
}

// ── 4. distance and drive / flight time per day ────────────────────────────

/** The travel chart's periods: all but All time (the fleet report covers at most 92 days). */
const TRAVEL_PERIODS = PERIODS.filter((p) => p.id !== 'all');
type TravelPeriod = Exclude<PeriodId, 'all'>;

function Travel() {
  const [metric, setMetric] = useState<'distance' | 'time'>('distance');
  const [period, setPeriod] = useState<TravelPeriod>('30d');
  const hourly = isHourly(period);
  const daily = useFleetReport(periodDays(period), !hourly);
  // The hourly window is fixed when the period is picked (and refreshed every 5 minutes), not on every render.
  const [bounds, setBounds] = useState(() => periodBounds(period));
  useEffect(() => {
    setBounds(periodBounds(period));
    if (!hourly) return;
    const t = window.setInterval(() => setBounds(periodBounds(period)), 300_000);
    return () => window.clearInterval(t);
  }, [period, hourly]);
  const hours = useQuery({
    queryKey: ['fleet-hourly', bounds.from, bounds.to],
    queryFn: () => api.get<FleetHourlyDto>('/reports/fleet/hourly', { from: bounds.from!, to: bounds.to! }),
    enabled: hourly && !!bounds.from,
    placeholderData: keepPreviousData,
    staleTime: 120_000,
  });
  const label = TRAVEL_PERIODS.find((p) => p.id === period)!.label;
  return (
    <section aria-labelledby="travel-h" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="travel-h" className="text-xl font-semibold">
          Distance &amp; flight time · {label.toLowerCase()}
        </h2>
        <Segmented
          label="Show"
          value={metric}
          onChange={setMetric}
          options={[
            ['distance', 'Distance'],
            ['time', 'Drive / flight time'],
          ]}
        />
      </div>
      <div className="mb-4">
        <Segmented label="Period" value={period} onChange={setPeriod} options={TRAVEL_PERIODS.map((p) => [p.id as TravelPeriod, p.label] as const)} />
      </div>
      {hourly ? (
        <QueryView query={hours} rows={4}>
          {(r) => (
            <Card bodyClassName="p-5">
              <CategoryPerDayChart hourly metric={metric} rows={r.hours.map((h) => ({ date: h.hour, by_category: h.by_category }))} />
            </Card>
          )}
        </QueryView>
      ) : (
        <QueryView query={daily} rows={4}>
          {(r) => (
            <Card bodyClassName="p-5">
              <CategoryPerDayChart rows={r.daily} metric={metric} />
            </Card>
          )}
        </QueryView>
      )}
    </section>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────

function SectionTitle({ id, title, href, link }: { id: string; title: string; href: string; link: string }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      <Link href={href} className="inline-flex items-center gap-1 text-base font-medium text-accent-text hover:underline">
        {link} <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}
