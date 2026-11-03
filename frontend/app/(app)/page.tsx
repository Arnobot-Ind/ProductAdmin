'use client';

import type { CategorySummaryDto, DashboardDto, FleetHourlyDto, MissionPeriodStatsDto, ReleaseDto, RobotCategory, SiteDto, SoftwareProductDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AlertOctagon, AlertTriangle, ArrowRight, Bell, CheckCircle2, Plane, Plus, Truck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { CATEGORIES, CategoryPerDayChart, Donut, MiniResultColumns, RankBars, ShareBar } from '@/components/domain/charts';
import { Segmented } from '@/components/ui/segmented';
import { isHourly, periodBounds, periodDays, PERIODS, type PeriodId } from '@/lib/periods';
import { attentionItems, AttentionList, faultTitle, FleetMap, useDashboard, useFleetReport } from '@/components/domain/dashboard';
import { useRobotDirectory } from '@/components/domain/robot-ref';
import { Card, QueryView } from '@/components/ui/misc';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtDuration, humanize } from '@/lib/format';
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
 *  1. every robot by status (a ring); one line of what needs a person (faults, unreviewed alerts, warranties); when
 *     the most frequent problems; mission results per day over 30 days; robots by site; the date and time as one line;
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

// ── 1. date & time, robots by status, what needs a person, fleet health ────

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
  return (
    // A plain white card like the UGV / UAV boxes (no brand band), in light and dark theme alike.
    <section aria-labelledby="hero-h" className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
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
      <div className="grid gap-8 p-6 sm:p-8 xl:grid-cols-[auto_minmax(0,1fr)]">
        <div className="min-w-0 xl:border-r xl:border-border xl:pr-10">
          <h2 className="mb-3 text-base font-semibold">Total Bots</h2>
          <Donut label="Robots by status" sub={`robot${d.robots_total === 1 ? '' : 's'}`} parts={STATUS.map((s) => ({ label: s.label, value: d.by_status[s.key], color: s.color }))} />
          <Totals d={d} />
        </div>

        {/* Stretches to the left column's height, so Most frequent problems ends level with Totals. */}
        <div className="flex min-w-0 flex-col">
          <AlertLine d={d} />
          <TopProblems d={d} />
        </div>
      </div>
      <div className="grid gap-5 border-t border-border p-6 sm:p-8 lg:grid-cols-2">
        <MissionResults />
        <RobotsBySite total={d.robots_total} />
      </div>
    </section>
  );
}

/**
 * Everything that needs a person, in one line: problems going on now, alerts nobody has looked at yet, and warranties
 * ending. Each part opens the list behind it; the Needs action list further down shows the items themselves.
 */
function AlertLine({ d }: { d: DashboardDto }) {
  const critical = d.active_faults.filter((f) => f.severity === 'critical').length;
  const warnings = d.active_faults.length - critical;
  const unseen = d.unacked_critical_events + d.unacked_warning_events;
  const parts: { key: string; n: number; text: string; href: string; tone: 'fault' | 'warn' | 'muted'; title: string }[] = [
    { key: 'crit', n: critical, text: `critical fault${critical === 1 ? '' : 's'} now`, href: '/overview/attention', tone: 'fault', title: 'Problems still going on: reported by a robot and not reported cleared yet.' },
    { key: 'warn', n: warnings, text: `warning${warnings === 1 ? '' : 's'} now`, href: '/overview/attention', tone: 'warn', title: 'Warnings still going on.' },
    {
      key: 'unseen',
      n: unseen,
      text: `alert${unseen === 1 ? '' : 's'} not reviewed`,
      href: '/overview/attention',
      tone: 'muted',
      title: `${d.unacked_critical_events} critical and ${d.unacked_warning_events} warning messages nobody has acknowledged yet, including ones already cleared.`,
    },
    { key: 'warranty', n: d.warranty_expiring.length, text: `warrant${d.warranty_expiring.length === 1 ? 'y' : 'ies'} ending soon`, href: '/overview/attention', tone: 'warn', title: 'Robots whose warranty ends within 30 days.' },
  ];
  const shown = parts.filter((x) => x.n > 0);
  return (
    <p className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-border bg-surface px-4 py-2.5 text-base">
      {shown.length === 0 ? (
        <span className="text-muted">No faults, alerts or warranties need anyone right now.</span>
      ) : (
        shown.map((x) => {
          const Icon = x.tone === 'fault' ? AlertOctagon : x.tone === 'warn' ? AlertTriangle : Bell;
          return (
            <Link key={x.key} href={x.href} title={x.title} className="inline-flex items-center gap-1.5 hover:underline">
              <Icon className={cn('size-4 shrink-0', x.tone === 'fault' ? 'text-fault' : x.tone === 'warn' ? 'text-warn' : 'text-muted')} aria-hidden />
              <span className={cn('font-semibold tabular-nums', x.tone === 'fault' && 'text-fault')}>{x.n.toLocaleString('en-IN')}</span>
              <span className="text-muted">{x.text}</span>
            </Link>
          );
        })
      )}
    </p>
  );
}

/** A titled block in the overview band: what it shows, its headline figure, the chart, and where to go next. */
function Panel({ title, headline, href, link, className, children }: { title: string; headline: ReactNode; href: string; link: string; className?: string; children: ReactNode }) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-border bg-surface p-4', className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold">
          <Link href={href} className="hover:underline">
            {title}
          </Link>
        </h3>
        <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline">
          {link} <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      <p className="mb-3 text-sm text-muted">{headline}</p>
      {children}
    </section>
  );
}

/**
 * The problems that keep coming back: unreviewed critical alerts grouped by what went wrong, most frequent first,
 * with how many robots report each. One look says what to fix first across the fleet.
 */
function TopProblems({ d }: { d: DashboardDto }) {
  const by = new Map<string, { title: string; count: number; robots: Set<string> }>();
  for (const g of d.critical_event_groups) {
    const key = g.code ?? g.latest.type;
    const x = by.get(key) ?? { title: faultTitle(g.code, humanize(g.latest.type)), count: 0, robots: new Set<string>() };
    x.count += g.count;
    x.robots.add(g.robot_id);
    by.set(key, x);
  }
  const rows = [...by.entries()].sort((a, b) => b[1].count - a[1].count);
  // Up to 8 kinds: enough to fill the card beside Totals; the rest are counted below.
  const top = rows.slice(0, 8);
  const robots = new Set(d.critical_event_groups.map((g) => g.robot_id)).size;
  return (
    <Panel
      className="xl:flex-1"
      title="Most frequent problems"
      href="/overview/attention"
      link="Review"
      headline={
        rows.length ? (
          <>
            <span className="text-lg font-semibold text-fg tabular-nums">{rows.length}</span> kind{rows.length === 1 ? '' : 's'} of critical alert not reviewed yet, on {robots} robot
            {robots === 1 ? '' : 's'}
          </>
        ) : (
          'No unreviewed critical alerts'
        )
      }
    >
      {rows.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <CheckCircle2 className="size-4 text-ok" aria-hidden /> Nothing keeps coming back right now.
        </p>
      ) : (
        // The whole list opens Needs attention, where these alerts are reviewed.
        <Link href="/overview/attention" title="Review these problems in Needs attention" className="-mx-2 block rounded-lg px-2 py-1 hover:bg-surface-2">
          <RankBars
            rows={top.map(([key, x]) => ({
              key,
              label: <span className="font-sans font-medium">{x.title}</span>,
              value: x.count,
              display: `${x.count.toLocaleString('en-IN')}×`,
              detail: `${x.title}: ${x.count} time(s) on ${x.robots.size} robot(s): ${[...x.robots].join(', ')}`,
            }))}
            color="var(--chart-critical)"
          />
        </Link>
      )}
      {rows.length > top.length && <p className="mt-2 text-xs text-muted">and {rows.length - top.length} more kinds</p>}
    </Panel>
  );
}

/**
 * The catalogue at a glance, as horizontal bars like the most frequent problems. Hardware first, counted in robots:
 * built on a UGV / UAV base model, with at least one attachment fitted. Then software, counted as items: releases
 * registered, client software in the catalogue. Hover a bar for what it counts.
 */
function Totals({ d }: { d: DashboardDto }) {
  const can = useCan();
  const dir = useRobotDirectory();
  const software = useQuery({ queryKey: ['software-products', false], queryFn: () => api.get<SoftwareProductDto[]>('/software-products', { include_deleted: false }), enabled: can('org.manage'), staleTime: 300_000 });
  const releases = useQuery({ queryKey: ['releases', 'all'], queryFn: () => api.get<ReleaseDto[]>('/releases'), enabled: can('catalog.read'), staleTime: 300_000 });
  const robots = [...dir.values()];
  const known = can('robot.details') && dir.size > 0;
  const rows = [
    { key: 'ugv', label: 'UGV base models', href: '/robots?category=ugv', value: d.by_category.ugv.robots, detail: 'Robots built on a UGV base model', show: true },
    { key: 'uav', label: 'UAV base models', href: '/robots?category=uav', value: d.by_category.uav.robots, detail: 'Robots built on a UAV base model', show: true },
    { key: 'att', label: 'Attachments', href: '/products', value: robots.filter((r) => r.attachments.length > 0).length, detail: 'Robots with at least one attachment fitted', show: known },
    { key: 'rel', label: 'Software releases', href: '/releases', value: releases.data?.length ?? 0, detail: 'Software and firmware releases registered', show: can('catalog.read') && !!releases.data },
    { key: 'sw', label: 'Client software', href: '/admin/software', value: software.data?.length ?? 0, detail: 'Software in the client software catalogue', show: can('org.manage') && !!software.data },
  ].filter((r) => r.show);
  return (
    <section aria-labelledby="totals-h" className="mt-6 border-t border-border pt-5">
      <h2 id="totals-h" className="text-base font-semibold">
        Hardware &amp; software
      </h2>
      <p className="mb-3 text-sm text-muted">Robots on each type, out of {d.robots_total} · software we have</p>
      <RankBars
        keepOrder
        rows={rows.map((r) => ({
          key: r.key,
          label: (
            <Link href={r.href} className="font-sans font-medium hover:text-accent-text hover:underline">
              {r.label}
            </Link>
          ),
          value: r.value,
          display: String(r.value),
          detail: `${r.detail}: ${r.value}`,
          color: r.key === 'ugv' || r.key === 'uav' ? `var(--cat-${r.key})` : undefined,
        }))}
        empty="No robots registered yet."
      />
    </section>
  );
}

/** Mission results per day over the last 30 days, with the success rate (completed out of all finished). */
function MissionResults() {
  const [bounds] = useState(() => periodBounds('30d'));
  const q = useQuery({
    queryKey: ['missions', 'stats', bounds.from, bounds.to],
    queryFn: () => api.get<MissionPeriodStatsDto>('/missions/stats', bounds),
    staleTime: 60_000,
  });
  const t = q.data?.totals;
  const finished = t ? t.completed + t.aborted + t.failed : 0;
  return (
    <Panel
      title="Mission results · 30 days"
      href="/overview/missions?period=30d"
      link="Missions"
      headline={
        !t ? (
          '…'
        ) : finished ? (
          <>
            <span className={cn('text-lg font-semibold tabular-nums', t.completed / finished < 0.7 ? 'text-warn' : 'text-fg')}>{Math.round((t.completed / finished) * 100)} %</span> of finished missions
            completed ({t.completed} of {finished})
          </>
        ) : (
          'No missions finished in the last 30 days'
        )
      }
    >
      {q.data && <MiniResultColumns rows={q.data.buckets.map((b) => ({ date: b.start, completed: b.completed, aborted: b.aborted, failed: b.failed }))} />}
    </Panel>
  );
}

/** Where the fleet is deployed: robots at each site (largest first) and how many are not at any site. */
function RobotsBySite({ total }: { total: number }) {
  const can = useCan();
  const sites = useQuery({ queryKey: ['sites', { includeDeleted: false }], queryFn: () => api.get<SiteDto[]>('/sites'), enabled: can('robot.details'), staleTime: 120_000 });
  const at = (sites.data ?? []).filter((x) => x.robots_now > 0);
  const deployed = at.reduce((n, x) => n + x.robots_now, 0);
  const rows = [
    ...at.slice(0, 5).map((x) => ({ key: x.id, label: <Link href={`/sites/${x.id}`} className="font-sans hover:underline">{x.name}</Link>, value: x.robots_now, display: String(x.robots_now), detail: `${x.name}: ${x.robots_now} robot(s)` })),
    ...(at.length > 5 ? [{ key: 'more', label: <span className="font-sans">{at.length - 5} more sites</span>, value: at.slice(5).reduce((n, x) => n + x.robots_now, 0), display: String(at.slice(5).reduce((n, x) => n + x.robots_now, 0)) }] : []),
    { key: 'none', label: <span className="font-sans text-muted">Not deployed</span>, value: total - deployed, display: String(total - deployed) },
  ];
  return (
    <Panel
      title="Robots by site"
      href="/sites"
      link="Sites"
      headline={
        <>
          <span className="text-lg font-semibold text-fg tabular-nums">{deployed}</span> of {total} robots deployed
          {at.length ? ` at ${at.length} site${at.length === 1 ? '' : 's'}` : ''}
        </>
      }
    >
      {!sites.data ? null : sites.data.length === 0 ? (
        <p className="text-sm text-muted">
          No sites yet.{' '}
          <Link href="/sites" className="font-medium text-accent-text hover:underline">
            Add the places your robots work
          </Link>{' '}
          to see the fleet by site here.
        </p>
      ) : (
        <RankBars rows={rows} />
      )}
    </Panel>
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
