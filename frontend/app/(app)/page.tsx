'use client';

import type { DashboardDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, Bot, CalendarClock, ChevronRight, CircleDot, Inbox, ShieldAlert, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { GeoMap } from '@/components/domain/geo-map';
import type { ReactNode } from 'react';
import { missionHref } from '@/components/domain/missions-table';
import { MissionResultBadge, SeverityBadge } from '@/components/domain/status';
import { LinkButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDate, fmtRelative } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

function Stat({ label, value, icon, tone, href, sub }: { label: string; value: ReactNode; icon: ReactNode; tone?: 'ok' | 'warn' | 'fault' | 'offline'; href?: string; sub?: string }) {
  const body = (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/50">
      <span
        className={cn(
          'flex size-10 items-center justify-center rounded-md',
          tone === 'ok' && 'bg-ok-bg text-ok',
          tone === 'warn' && 'bg-warn-bg text-warn',
          tone === 'fault' && 'bg-fault-bg text-fault',
          tone === 'offline' && 'bg-offline-bg text-offline',
          !tone && 'bg-accent-soft text-accent-text',
        )}
        aria-hidden
      >
        {icon}
      </span>
      <span>
        <span className="block text-2xl font-bold tabular-nums">{value}</span>
        <span className="block text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
        {sub && <span className="block text-xs text-muted">{sub}</span>}
      </span>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-lg">
      {body}
    </Link>
  ) : (
    body
  );
}

export default function DashboardPage() {
  useDocumentTitle('Dashboard');
  const can = useCan();
  const poll = useLivePoll();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardDto>('/dashboard'), refetchInterval: poll || 30_000 });

  return (
    <>
      <PageHeader
        eyebrow="Arnobot PMS"
        title="Fleet dashboard"
        description="Status is computed from last-seen time: Online < 60 s, Stale 60 s – 5 min, Offline > 5 min."
        actions={can('robot.write') ? <LinkButton href="/robots/new" variant="primary">Register robot</LinkButton> : undefined}
      />
      <QueryView query={q} rows={8}>
        {(d) => (
          <div className="flex flex-col gap-6">
            <section aria-label="Fleet status" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Stat label="Robots" value={d.robots_total} icon={<Bot className="size-5" />} href="/robots" />
              <Stat label="Online" value={d.by_status.online} tone="ok" icon={<CircleDot className="size-5" />} href="/robots?status=online" />
              <Stat label="Stale" value={d.by_status.stale} tone="warn" icon={<ShieldAlert className="size-5" />} href="/robots?status=stale" />
              <Stat label="Offline" value={d.by_status.offline} tone="offline" icon={<WifiOff className="size-5" />} href="/robots?status=offline" />
              <Stat
                label="Critical alerts"
                value={d.unacked_critical_events}
                tone={d.unacked_critical_events ? 'fault' : undefined}
                icon={<AlertOctagon className="size-5" />}
                href="/robots?sort=-unacked_critical_events"
              />
              <Stat label="Messages today" value={d.messages_last_24h.toLocaleString()} icon={<Inbox className="size-5" />} />
            </section>

            <div className="grid gap-6 xl:grid-cols-3">
              <FleetMap d={d} />
              <div className="flex flex-col gap-6">
                <Attention d={d} />
                <MissionsWeek d={d} />
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              <Card title="Recent missions" bodyClassName="p-0">
                {d.recent_missions.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No missions yet" description="Missions appear when a robot or the GCS reports one." />
                  </div>
                ) : (
                  <DataTable
                    caption="Recent missions"
                    dense
                    rows={d.recent_missions.slice(0, 5)}
                    rowKey={(m) => m.mission_id}
                    columns={[
                      {
                        key: 'id',
                        header: 'Mission',
                        rowHeader: true,
                        cell: (m) => (
                          <Link className="block max-w-44 truncate font-mono text-accent-text hover:underline" href={missionHref(m)} title={m.mission_id}>
                            {m.mission_id}
                          </Link>
                        ),
                      },
                      { key: 'robot', header: 'Robot', cell: (m) => <Link className="font-mono text-accent-text hover:underline" href={`/robots/${m.robot_id}?tab=missions`}>{m.robot_id}</Link> },
                      { key: 'start', header: 'Started', cell: (m) => <span className="whitespace-nowrap"><Time iso={m.started_at} relative /></span> },
                      { key: 'res', header: 'Result', cell: (m) => <MissionResultBadge result={m.result} /> },
                    ]}
                  />
                )}
              </Card>
              <Card title="Recent events" bodyClassName="p-0">
                {d.recent_events.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title="No events yet" />
                  </div>
                ) : (
                  <DataTable
                    caption="Recent events"
                    dense
                    rows={d.recent_events.slice(0, 5)}
                    rowKey={(e) => e.id}
                    columns={[
                      { key: 'ts', header: 'Time', cell: (e) => <span className="whitespace-nowrap"><Time iso={e.ts} relative /></span> },
                      { key: 'robot', header: 'Robot', cell: (e) => <Link className="font-mono text-accent-text hover:underline" href={`/robots/${e.robot_id}?tab=events`}>{e.robot_id}</Link> },
                      { key: 'sev', header: 'Severity', cell: (e) => <SeverityBadge severity={e.severity} /> },
                      { key: 'msg', header: 'Message', cell: (e) => <span className="line-clamp-1" title={e.message}>{e.message}</span> },
                    ]}
                  />
                )}
              </Card>
            </div>
          </div>
        )}
      </QueryView>
    </>
  );
}

const STATUS_COLOR = { online: '#16a34a', stale: '#d97706', offline: '#6b7280' } as const;

/** Every robot at its last reported position; colour = status. Hover for details, click to open the robot. */
function FleetMap({ d }: { d: DashboardDto }) {
  const router = useRouter();
  const placed = d.fleet.filter((r) => r.lat !== null && r.lon !== null);
  const points = useMemo(
    () =>
      placed.map((r) => ({
        id: r.robot_id,
        lat: r.lat!,
        lon: r.lon!,
        color: STATUS_COLOR[r.status],
        label: `${r.robot_id} · ${r.status}${r.battery_pct !== null ? ` · ${Math.round(r.battery_pct)} %` : ''}`,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(placed)],
  );
  const unplaced = d.fleet.length - placed.length;
  return (
    <Card
      title="Fleet map"
      className="flex flex-col xl:col-span-2"
      bodyClassName="flex flex-1 flex-col p-4"
      actions={
        <span className="flex flex-wrap items-center gap-3 text-xs text-muted">
          {(['online', 'stale', 'offline'] as const).map((st) => (
            <span key={st} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: STATUS_COLOR[st] }} aria-hidden />
              {st[0].toUpperCase() + st.slice(1)} {d.by_status[st]}
            </span>
          ))}
        </span>
      }
    >
      {placed.length ? (
        <>
          <GeoMap points={points} className="min-h-80 flex-1" ariaLabel={`Fleet map: ${placed.length} robots with a known position`} onPointClick={(id) => router.push(`/robots/${id}`)} />
          <p className="mt-2 text-xs text-muted">
            Last reported position of each robot. Hover a dot for details, click to open the robot.
            {unplaced > 0 && ` ${unplaced} robot${unplaced === 1 ? ' has' : 's have'} not reported a position yet.`}
          </p>
        </>
      ) : (
        <EmptyState title="No positions yet" description="Robots appear on the map once they report a GPS position." />
      )}
    </Card>
  );
}

/** What needs someone's attention, most urgent first. */
function Attention({ d }: { d: DashboardDto }) {
  const items: { key: string; tone: 'fault' | 'warn' | 'offline'; icon: ReactNode; title: ReactNode; sub: string; href: string }[] = [];
  const critical = d.recent_events.filter((e) => e.severity === 'critical' && !e.acknowledged_at);
  if (d.unacked_critical_events) {
    items.push({
      key: 'crit',
      tone: 'fault',
      icon: <AlertOctagon className="size-4" />,
      title: `${d.unacked_critical_events} unacknowledged critical event${d.unacked_critical_events === 1 ? '' : 's'}`,
      sub: critical[0] ? `Latest: ${critical[0].robot_id} · ${critical[0].message}` : 'Open the robot to acknowledge',
      href: critical[0] ? `/robots/${critical[0].robot_id}?tab=events` : '/robots?sort=-unacked_critical_events',
    });
  }
  for (const r of d.robots_with_fault) {
    items.push({ key: `f-${r.robot_id}`, tone: 'fault', icon: <AlertTriangle className="size-4" />, title: <span className="font-mono">{r.robot_id}</span>, sub: `Device fault: ${r.devices.join(', ')}`, href: `/robots/${r.robot_id}` });
  }
  for (const r of d.fleet.filter((x) => x.status === 'offline')) {
    items.push({
      key: `o-${r.robot_id}`,
      tone: 'offline',
      icon: <WifiOff className="size-4" />,
      title: <span className="font-mono">{r.robot_id}</span>,
      sub: r.last_seen_at ? `Offline · last seen ${fmtRelative(r.last_seen_at)}` : 'Never connected',
      href: `/robots/${r.robot_id}`,
    });
  }
  for (const w of d.warranty_expiring) {
    items.push({ key: `w-${w.robot_id}`, tone: 'warn', icon: <CalendarClock className="size-4" />, title: <span className="font-mono">{w.robot_id}</span>, sub: `Warranty ends ${fmtDate(w.warranty_end)}`, href: `/robots/${w.robot_id}?tab=dispatch` });
  }
  const tone = { fault: 'bg-fault-bg text-fault', warn: 'bg-warn-bg text-warn', offline: 'bg-offline-bg text-offline' };
  return (
    <Card title="Needs attention" className="flex min-h-0 flex-1 flex-col" actions={items.length ? <Badge tone={items.some((i) => i.tone === 'fault') ? 'fault' : 'warn'}>{items.length}</Badge> : <Badge tone="ok">All clear</Badge>} bodyClassName="p-0">
      {items.length === 0 ? (
        <p className="p-4 text-sm text-muted">No faults, critical events, offline robots or expiring warranties.</p>
      ) : (
        <ul className="max-h-72 flex-1 divide-y divide-border overflow-y-auto">
          {items.map((i) => (
            <li key={i.key}>
              <Link href={i.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', tone[i.tone])} aria-hidden>
                  {i.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{i.title}</span>
                  <span className="block truncate text-xs text-muted">{i.sub}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MissionsWeek({ d }: { d: DashboardDto }) {
  const m = d.missions_last_7d;
  const total = m.completed + m.failed + m.aborted + m.in_progress;
  const parts = [
    ['Completed', m.completed, 'bg-ok', 'text-ok'],
    ['Failed', m.failed, 'bg-fault', 'text-fault'],
    ['Aborted', m.aborted, 'bg-warn', 'text-warn'],
    ['In progress', m.in_progress, 'bg-accent', 'text-accent-text'],
  ] as const;
  return (
    <Card title="Missions · last 7 days" actions={<span className="text-sm font-semibold tabular-nums">{total}</span>}>
      {total > 0 && (
        <div className="mb-3 flex h-2.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={parts.map(([l, n]) => `${n} ${l.toLowerCase()}`).join(', ')}>
          {parts.map(([l, n, bg]) => (
            <span key={l} className={bg} style={{ width: `${(n / total) * 100}%` }} />
          ))}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-2">
        {parts.map(([label, n, , text]) => (
          <div key={label} className="rounded-md bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted uppercase">{label}</dt>
            <dd className={cn('text-xl font-bold tabular-nums', text)}>{n}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
