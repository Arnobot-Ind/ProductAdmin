'use client';

import type { DashboardDto } from '@arnobot/message-schema';
import { AlertOctagon, Bot, ChevronRight, Inbox, ListChecks, Map as MapIcon, Route, Siren } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DistancePerDayChart, MissionsPerDayChart, ShareBar } from '@/components/domain/charts';
import { attentionItems, AttentionList, DashboardPage, useFleetReport } from '@/components/domain/dashboard';
import { LinkButton } from '@/components/ui/button';
import { Card, QueryView } from '@/components/ui/misc';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtRelative } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';

type Tone = 'fault';
const TONE: Record<Tone, string> = { fault: 'bg-fault-bg text-fault' };

/** Dashboard summary: the fleet's key numbers and the most urgent items. The other topics are their own pages, listed in the 9-dot menu. */
export default function DashboardSummaryPage() {
  useDocumentTitle('Dashboard');
  const can = useCan();
  return (
    <DashboardPage
      title="Dashboard"
      description="Your fleet at a glance."
      actions={can('robot.write') ? <LinkButton href="/robots/new" variant="primary">Register robot</LinkButton> : undefined}
    >
      {(d) => <Summary d={d} />}
    </DashboardPage>
  );
}

function Summary({ d }: { d: DashboardDto }) {
  const attention = attentionItems(d);
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="fleet-status">
        <h2 id="fleet-status" className="mb-4 text-xl font-semibold">
          Fleet status
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Robots" value={d.robots_total} icon={<Bot className="size-6" />} href="/robots" />
          {/* Online / stale / offline as one bar: the share reads at a glance, the legend carries the counts. */}
          <section aria-label="Robot status" className="col-span-2 flex flex-col justify-center gap-1 rounded-xl border border-border bg-surface p-5 shadow-sm md:col-span-3">
            <p className="mb-3 text-base text-muted">Robot status now</p>
            <ShareBar
              label="Robot status"
              parts={[
                { label: 'Online', value: d.by_status.online, color: 'var(--chart-good)' },
                { label: 'Stale', value: d.by_status.stale, color: 'var(--chart-warning)' },
                { label: 'Offline', value: d.by_status.offline, color: 'var(--chart-neutral)' },
              ]}
            />
          </section>
          <Stat label="Critical alerts" value={d.unacked_critical_events} tone={d.unacked_critical_events ? 'fault' : undefined} icon={<AlertOctagon className="size-6" />} href="/robots?sort=-unacked_critical_events" />
          <Stat label="Messages today" value={d.messages_last_24h.toLocaleString()} icon={<Inbox className="size-6" />} />
        </div>
      </section>

      {/* The dashboard's own pages, offered once here (and in the 9-dot menu); the pages themselves do not repeat them. */}
      <section aria-labelledby="go-to">
        <h2 id="go-to" className="mb-4 text-xl font-semibold">
          Go to
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <GoTo href="/overview/attention" icon={<Siren className="size-5" />} title="Needs attention" value={attention.length ? `${attention.length} items` : 'All clear'} tone={attention.some((i) => i.tone === 'fault') ? 'fault' : undefined} />
          <GoTo href="/overview/map" icon={<MapIcon className="size-5" />} title="Fleet map" value={`${d.fleet.filter((r) => r.lat !== null && r.lon !== null).length} of ${d.fleet.length} robots placed`} />
          <GoTo href="/overview/missions" icon={<Route className="size-5" />} title="Missions" value={`${d.missions_last_7d.completed + d.missions_last_7d.aborted + d.missions_last_7d.failed + d.missions_last_7d.in_progress} in the last 7 days`} />
          <GoTo href="/overview/events" icon={<ListChecks className="size-5" />} title="Events" value={d.recent_events[0] ? `Latest ${fmtRelative(d.recent_events[0].ts)}` : 'None yet'} />
        </div>
      </section>

      {attention.length > 0 && (
        <section aria-labelledby="top-attention">
          <h2 id="top-attention" className="mb-4 text-xl font-semibold">
            Most urgent
          </h2>
          <AttentionList items={attention} limit={3} />
        </section>
      )}

      <LastThirtyDays />
    </div>
  );
}

/** Trends from the fleet report: missions by result and distance driven, per day. */
function LastThirtyDays() {
  const q = useFleetReport(30);
  return (
    <section aria-labelledby="last-30">
      <h2 id="last-30" className="mb-4 text-xl font-semibold">
        Last 30 days
      </h2>
      <QueryView query={q} rows={4}>
        {(r) => (
          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Missions per day" actions={<span className="text-base font-semibold tabular-nums">{r.totals.total} missions</span>}>
              <MissionsPerDayChart rows={r.daily} />
            </Card>
            <Card title="Distance driven per day" actions={<span className="text-base font-semibold tabular-nums">{fmtDistance(r.totals.driven_m)}</span>}>
              <DistancePerDayChart rows={r.daily} note="Kilometres driven each day, all robots" />
            </Card>
          </div>
        )}
      </QueryView>
    </section>
  );
}

function GoTo({ href, icon, title, value, tone }: { href: string; icon: ReactNode; title: string; value: string; tone?: 'fault' }) {
  return (
    <Link href={href} className="group flex items-center gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors hover:border-accent/50 hover:bg-surface-2">
      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-lg', tone ? TONE[tone] : 'bg-accent-soft text-accent-text')} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold">{title}</span>
        <span className={cn('block truncate text-sm', tone ? 'text-fault' : 'text-muted')}>{value}</span>
      </span>
      <ChevronRight className="size-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}

function Stat({ label, value, icon, tone, href }: { label: string; value: ReactNode; icon: ReactNode; tone?: Tone; href?: string }) {
  const body = (
    <div className="flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-sm transition-colors hover:border-accent/50">
      <span className={cn('flex size-11 items-center justify-center rounded-lg', tone ? TONE[tone] : 'bg-accent-soft text-accent-text')} aria-hidden>
        {icon}
      </span>
      <span>
        <span className="block text-3xl font-bold tabular-nums">{value}</span>
        <span className="block text-base text-muted">{label}</span>
      </span>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl">
      {body}
    </Link>
  ) : (
    body
  );
}
