'use client';

import type { DashboardDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, Bot, CircleDot, Inbox, ShieldAlert, WifiOff } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { missionHref } from '@/components/domain/missions-table';
import { MissionResultBadge, SeverityBadge, eventTypeLabel } from '@/components/domain/status';
import { LinkButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDistance, fmtDuration } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

function Stat({ label, value, icon, tone, href }: { label: string; value: ReactNode; icon: ReactNode; tone?: 'ok' | 'warn' | 'fault' | 'offline'; href?: string }) {
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
                label="Unacked critical"
                value={d.unacked_critical_events}
                tone={d.unacked_critical_events ? 'fault' : undefined}
                icon={<AlertOctagon className="size-5" />}
                href="/robots?sort=-unacked_critical_events"
              />
              <Stat label="Messages · 24 h" value={d.messages_last_24h.toLocaleString()} icon={<Inbox className="size-5" />} />
            </section>

            <div className="grid gap-6 xl:grid-cols-3">
              <Card title="Robots with a device fault" className="xl:col-span-1">
                {d.robots_with_fault.length === 0 ? (
                  <p className="text-sm text-muted">No device is reporting a fault.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {d.robots_with_fault.map((r) => (
                      <li key={r.robot_id} className="flex flex-wrap items-center justify-between gap-2">
                        <Link href={`/robots/${r.robot_id}`} className="font-mono font-semibold text-accent-text underline-offset-2 hover:underline">
                          {r.robot_id}
                        </Link>
                        <span className="flex flex-wrap gap-1">
                          {r.devices.map((dev) => (
                            <Badge key={dev} tone="fault">
                              {dev}: Fault
                            </Badge>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="Missions · last 7 days" className="xl:col-span-1">
                <dl className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ['Completed', d.missions_last_7d.completed, 'text-ok'],
                      ['Failed', d.missions_last_7d.failed, 'text-fault'],
                      ['Aborted', d.missions_last_7d.aborted, 'text-warn'],
                      ['In progress', d.missions_last_7d.in_progress, 'text-accent-text'],
                    ] as const
                  ).map(([label, n, cls]) => (
                    <div key={label} className="rounded-md bg-surface-2 px-3 py-2">
                      <dt className="text-xs text-muted uppercase">{label}</dt>
                      <dd className={cn('text-xl font-bold tabular-nums', cls)}>{n}</dd>
                    </div>
                  ))}
                </dl>
              </Card>

              <Card title="Warranty expiring (≤ 30 days)" className="xl:col-span-1">
                {d.warranty_expiring.length === 0 ? (
                  <p className="text-sm text-muted">No warranty ends in the next 30 days.</p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {d.warranty_expiring.map((w) => (
                      <li key={w.robot_id} className="flex justify-between gap-2">
                        <Link href={`/robots/${w.robot_id}?tab=dispatch`} className="font-mono text-accent-text hover:underline">
                          {w.robot_id}
                        </Link>
                        <span>ends {fmtDate(w.warranty_end)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
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
                    rows={d.recent_missions}
                    rowKey={(m) => m.mission_id}
                    columns={[
                      { key: 'id', header: 'Mission', rowHeader: true, cell: (m) => <Link className="font-mono text-accent-text hover:underline" href={missionHref(m)}>{m.mission_id}</Link> },
                      { key: 'robot', header: 'Robot', cell: (m) => <Link className="font-mono text-accent-text hover:underline" href={`/robots/${m.robot_id}?tab=missions`}>{m.robot_id}</Link> },
                      { key: 'start', header: 'Started', cell: (m) => <Time iso={m.started_at} /> },
                      { key: 'dur', header: 'Duration', align: 'right', cell: (m) => fmtDuration(m.duration_s) },
                      { key: 'dist', header: 'Distance', align: 'right', cell: (m) => fmtDistance(m.distance_m) },
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
                    rows={d.recent_events}
                    rowKey={(e) => e.id}
                    columns={[
                      { key: 'ts', header: 'Time', cell: (e) => <Time iso={e.ts} /> },
                      { key: 'robot', header: 'Robot', cell: (e) => <Link className="font-mono text-accent-text hover:underline" href={`/robots/${e.robot_id}?tab=events`}>{e.robot_id}</Link> },
                      { key: 'sev', header: 'Severity', cell: (e) => <SeverityBadge severity={e.severity} /> },
                      { key: 'type', header: 'Type', cell: (e) => eventTypeLabel(e.type) },
                      { key: 'msg', header: 'Message', cell: (e) => <span className="line-clamp-2">{e.message}</span> },
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
