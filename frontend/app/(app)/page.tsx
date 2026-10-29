'use client';

import type { DashboardDto, FleetReportDto } from '@arnobot/message-schema';
import { AlertTriangle, ArrowRight, BatteryLow, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { DistancePerDayChart, dayLabel, ShareBar } from '@/components/domain/charts';
import { attentionItems, AttentionList, useDashboard, useFleetReport } from '@/components/domain/dashboard';
import { Band, BandMeter } from '@/components/ui/band';
import { Card, QueryView } from '@/components/ui/misc';
import { useCan, useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtRelative } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';

type Robot = DashboardDto['fleet'][number];

const IST = 'Asia/Kolkata';
/** Status = state, so the reserved status tokens, always shown with their label. */
const STATUS: Record<Robot['status'], { label: string; color: string }> = {
  online: { label: 'Online', color: 'var(--chart-good)' },
  stale: { label: 'Stale', color: 'var(--chart-warning)' },
  offline: { label: 'Offline', color: 'var(--chart-neutral)' },
};

/**
 * The dashboard: a hero band with the fleet's headline (how many robots, how many are up, what needs a person),
 * the fleet itself as a wall of robot cards, the last 30 days as an activity strip, and what needs attention.
 * The other overview topics are their own pages, linked from the band (and listed in the 9-dot menu).
 */
export default function DashboardSummaryPage() {
  useDocumentTitle('Dashboard');
  const q = useDashboard();
  return (
    <QueryView query={q} rows={8}>
      {(d) => (
        <div className="flex flex-col gap-8">
          <Hero d={d} />
          <FleetWall fleet={d.fleet} />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:items-start">
            <LastThirtyDays />
            <section aria-labelledby="attention-h" className="min-w-0">
              <SectionTitle id="attention-h" title="Needs attention" href="/overview/attention" link="All items" />
              <AttentionList items={attentionItems(d)} limit={5} />
            </section>
          </div>
        </div>
      )}
    </QueryView>
  );
}

// ── hero band ───────────────────────────────────────────────────────────────

function greeting(): string {
  const h = Number(new Date().toLocaleString('en-GB', { timeZone: IST, hour: '2-digit', hour12: false }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** One plain sentence for the fleet's state, so the band reads like a status report, not a grid of numbers. */
function headline(d: DashboardDto): string {
  const { online, stale, offline } = d.by_status;
  if (!d.robots_total) return 'No robots registered yet.';
  if (online === d.robots_total) return 'Every robot is online.';
  if (!online && !stale) return 'No robot is reporting right now.';
  const parts = [online && `${online} online`, stale && `${stale} quiet for a while`, offline && `${offline} offline`].filter(Boolean);
  return `${parts.join(', ')}.`;
}

function Hero({ d }: { d: DashboardDto }) {
  const me = useMe();
  const can = useCan();
  const attention = attentionItems(d);
  const urgent = attention.filter((i) => i.tone === 'fault').length;
  const missions7 = d.missions_last_7d.completed + d.missions_last_7d.aborted + d.missions_last_7d.failed + d.missions_last_7d.in_progress;
  const placed = d.fleet.filter((r) => r.lat !== null && r.lon !== null).length;
  const today = new Date().toLocaleDateString('en-GB', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long' });
  const first = me.name.split(' ')[0];

  return (
    // The brand band: pale blue, with the fleet's headline.
    <Band labelledBy="hero-h">
      <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <p className="text-sm text-muted">
            {today} · {greeting()}, {first}
          </p>
          <h1 id="hero-h" className="mt-3 flex items-baseline gap-3">
            <span className="text-6xl leading-none font-semibold">{d.robots_total}</span>
            <span className="text-2xl font-semibold">robot{d.robots_total === 1 ? '' : 's'} in your fleet</span>
          </h1>
          <p className="mt-3 text-lg text-muted">{headline(d)}</p>
          <div className="mt-5 max-w-xl">
            <ShareBar large label="Robot status" parts={(['online', 'stale', 'offline'] as const).map((s) => ({ label: STATUS[s].label, value: d.by_status[s], color: STATUS[s].color }))} />
          </div>
        </div>

        {/* Three figures, divided by hairlines rather than boxed. */}
        <dl className="grid grid-cols-3 divide-x divide-border border-border lg:border-l lg:pl-2">
          <Figure label="Critical alerts" value={d.unacked_critical_events} href="/robots?sort=-unacked_critical_events" alert={d.unacked_critical_events > 0} />
          <Figure label="Missions, 7 days" value={missions7} href="/overview/missions" />
          <Figure label="Messages, 24 h" value={d.messages_last_24h} />
        </dl>
      </div>

      {/* The overview's own pages, once, as a quiet row along the band's foot. */}
      <nav aria-label="Overview pages" className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-border px-4 py-3 sm:px-6">
        <BandLink href="/overview/attention" label="Needs attention" note={attention.length ? `${attention.length}` : 'clear'} alert={urgent > 0} />
        <BandLink href="/overview/map" label="Fleet map" note={`${placed}/${d.fleet.length} placed`} />
        <BandLink href="/overview/missions" label="Missions" note={`${missions7} this week`} />
        <BandLink href="/overview/events" label="Events" note={d.recent_events[0] ? fmtRelative(d.recent_events[0].ts) : 'none'} />
        {can('robot.write') && (
          <Link href="/robots/new" className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-base font-semibold text-accent-fg hover:opacity-90">
            <Plus className="size-4" aria-hidden /> Register robot
          </Link>
        )}
      </nav>
    </Band>
  );
}

function Figure({ label, value, href, alert }: { label: string; value: number; href?: string; alert?: boolean }) {
  const body = (
    <>
      <dt className="text-base text-muted">{label}</dt>
      <dd className="mt-1 flex items-center gap-2 text-3xl font-semibold">
        {value.toLocaleString('en-IN')}
        {alert && <AlertTriangle className="size-5 text-warn" aria-label="needs attention" />}
      </dd>
    </>
  );
  return (
    <div className="min-w-0 px-4 first:pl-0 lg:first:pl-4">
      {href ? (
        <Link href={href} className="block rounded-md hover:opacity-80">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

function BandLink({ href, label, note, alert }: { href: string; label: string; note: string; alert?: boolean }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-2.5 rounded-lg px-3 py-2 text-base hover:bg-surface-2">
      <span className="font-semibold">{label}</span>
      <span className={cn('rounded-full px-2.5 py-0.5 text-sm font-medium', alert ? 'bg-warn/20 text-warn' : 'bg-surface-2 text-fg group-hover:bg-surface')}>{note}</span>
      <ArrowRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}

// ── fleet wall ──────────────────────────────────────────────────────────────

const WALL_MAX = 8;
/** Problems first (faults, then offline and stale), then the rest by name. */
const order = (r: Robot) => (r.faults.length ? 0 : r.status === 'offline' ? 1 : r.status === 'stale' ? 2 : 3);

function FleetWall({ fleet }: { fleet: Robot[] }) {
  const robots = [...fleet].sort((a, b) => order(a) - order(b) || a.robot_id.localeCompare(b.robot_id));
  const shown = robots.slice(0, WALL_MAX);
  return (
    <section aria-labelledby="fleet-h">
      <SectionTitle id="fleet-h" title="Your fleet" href="/robots" link={robots.length > WALL_MAX ? `All ${robots.length} robots` : 'All robots'} />
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-muted">No robots yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {shown.map((r) => (
            <li key={r.robot_id}>
              <RobotCard r={r} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RobotCard({ r }: { r: Robot }) {
  const s = STATUS[r.status];
  return (
    <Link
      href={`/robots/${r.robot_id}`}
      className="group flex h-full flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate font-mono text-lg font-semibold">{r.robot_id}</span>
          <span className="block truncate text-sm text-muted">{r.product_name}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium">
          <span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />
          {s.label}
        </span>
      </span>
      <Battery pct={r.battery_pct} />
      <span className="mt-auto flex items-center justify-between gap-2 text-sm text-muted">
        <span className="truncate">{r.last_seen_at ? `Seen ${fmtRelative(r.last_seen_at)}` : 'Never connected'}</span>
        {r.faults.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-fault">
            <AlertTriangle className="size-4" aria-hidden />
            {r.faults.length} fault{r.faults.length === 1 ? '' : 's'}
          </span>
        ) : (
          <ArrowRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
        )}
      </span>
    </Link>
  );
}

function Battery({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-sm text-muted">Battery not reported</span>;
  return (
    <span className="flex items-center gap-3">
      <span className="text-sm text-muted">{pct < 30 ? <BatteryLow className="size-4" aria-label="Battery low" /> : 'Battery'}</span>
      <span className="flex-1">
        <BandMeter pct={pct} />
      </span>
    </span>
  );
}

// ── last 30 days ────────────────────────────────────────────────────────────

function LastThirtyDays() {
  const q = useFleetReport(30);
  return (
    <section aria-labelledby="last30-h" className="min-w-0">
      <SectionTitle id="last30-h" title="Last 30 days" href="/overview/missions" link="Mission details" />
      <QueryView query={q} rows={4}>
        {(r) => (
          <Card bodyClassName="flex flex-col gap-6 p-5">
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Missions" value={r.totals.total.toLocaleString('en-IN')} />
              <Stat label="Distance driven" value={fmtDistance(r.totals.driven_m)} />
              <Stat label="Active days" value={`${r.daily.filter((x) => x.missions > 0 || x.driven_m > 0).length} of ${r.daily.length}`} />
            </div>
            <ActivityStrip days={r.daily} />
            <DistancePerDayChart rows={r.daily} note="Kilometres driven each day, all robots" />
          </Card>
        )}
      </QueryView>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 truncate text-2xl font-semibold">{value}</p>
    </div>
  );
}

/** One cell per day, shaded by missions that day (one hue, light to dark, like the robot calendar). Hover a day for its numbers. */
const SHADES = ['bg-surface-2', 'bg-accent/20', 'bg-accent/40', 'bg-accent/65', 'bg-accent'];
function ActivityStrip({ days }: { days: FleetReportDto['daily'] }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(0, ...days.map((d) => d.missions));
  const level = (n: number) => (n <= 0 || !max ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const h = days.find((d) => d.date === hover);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold">Missions each day</span>
        <span className="truncate text-muted">
          {h ? `${dayLabel(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${h.missions} mission${h.missions === 1 ? '' : 's'} · ${fmtDistance(h.driven_m)}` : 'Hover a day'}
        </span>
      </div>
      <div className="flex gap-[2px]" role="img" aria-label={`Missions per day over ${days.length} days, most ${max} in a day`}>
        {days.map((d) => (
          <span
            key={d.date}
            onMouseEnter={() => setHover(d.date)}
            onMouseLeave={() => setHover(null)}
            className={cn('h-9 flex-1 rounded-[4px] transition-opacity', SHADES[level(d.missions)], hover && hover !== d.date && 'opacity-60')}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <span>{days[0] && dayLabel(days[0].date, { day: 'numeric', month: 'short' })}</span>
        <span className="inline-flex items-center gap-1" aria-hidden>
          Less
          {SHADES.map((s) => (
            <span key={s} className={cn('size-3 rounded-sm', s)} />
          ))}
          More
        </span>
        <span>Today</span>
      </div>
    </div>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────

function SectionTitle({ id, title, href, link }: { id: string; title: string; href: string; link: string }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline">
        {link} <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}

