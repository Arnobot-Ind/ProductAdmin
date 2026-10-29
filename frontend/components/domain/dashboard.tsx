'use client';

import type { DashboardDto, FleetReportDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, CalendarClock, ChevronRight, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { istDay, ShareBar } from '@/components/domain/charts';
import { GeoMap } from '@/components/domain/geo-map';
import { missionHref } from '@/components/domain/missions-table';
import { MissionResultBadge, SeverityBadge } from '@/components/domain/status';
import { Badge, Card, EmptyState, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate, fmtRelative } from '@/lib/format';
import { useLivePoll } from '@/lib/realtime';

/**
 * The dashboard, one topic per page: Summary (/), Needs attention, Fleet map, Missions and Events (/overview/*).
 * Every page reads the same /dashboard response, so moving between them is instant.
 */
/** Missions and distance per IST day and per robot over the last `days` days (the same report the client portal uses). */
export function useFleetReport(days = 30) {
  const from = istDay(days - 1);
  const to = istDay();
  return useQuery({ queryKey: ['fleet-report', from, to], queryFn: () => api.get<FleetReportDto>('/reports/fleet', { from, to }), staleTime: 300_000, refetchInterval: 600_000 });
}

export function useDashboard() {
  const poll = useLivePoll();
  return useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardDto>('/dashboard'), refetchInterval: poll || 300_000 });
}

/** Page frame for every dashboard page: title, then the page's one topic. The pages are listed in the 9-dot menu. */
export function DashboardPage({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: (d: DashboardDto) => ReactNode }) {
  const q = useDashboard();
  return (
    <>
      <PageHeader eyebrow="Overview" title={title} description={description} actions={actions} />
      <QueryView query={q} rows={8}>
        {children}
      </QueryView>
    </>
  );
}

// ── Needs attention ─────────────────────────────────────────────────────────

type AttentionTone = 'fault' | 'warn' | 'offline';
export interface AttentionItem {
  key: string;
  tone: AttentionTone;
  icon: ReactNode;
  title: ReactNode;
  sub: string;
  href: string;
}

/** What needs someone's attention, most urgent first. */
export function attentionItems(d: DashboardDto): AttentionItem[] {
  const items: AttentionItem[] = [];
  const critical = d.recent_events.filter((e) => e.severity === 'critical' && !e.acknowledged_at);
  if (d.unacked_critical_events) {
    items.push({
      key: 'crit',
      tone: 'fault',
      icon: <AlertOctagon className="size-5" />,
      title: `${d.unacked_critical_events} unacknowledged critical event${d.unacked_critical_events === 1 ? '' : 's'}`,
      sub: critical[0] ? `Latest: ${critical[0].robot_id} · ${critical[0].message}` : 'Open the robot to acknowledge',
      href: critical[0] ? `/robots/${critical[0].robot_id}?tab=events` : '/robots?sort=-unacked_critical_events',
    });
  }
  for (const r of d.robots_with_fault) {
    items.push({ key: `f-${r.robot_id}`, tone: 'fault', icon: <AlertTriangle className="size-5" />, title: <span className="font-mono">{r.robot_id}</span>, sub: `Device fault: ${r.devices.join(', ')}`, href: `/robots/${r.robot_id}?tab=health` });
  }
  for (const r of d.fleet.filter((x) => x.status === 'offline')) {
    items.push({
      key: `o-${r.robot_id}`,
      tone: 'offline',
      icon: <WifiOff className="size-5" />,
      title: <span className="font-mono">{r.robot_id}</span>,
      sub: r.last_seen_at ? `Offline · last seen ${fmtRelative(r.last_seen_at)}` : 'Never connected',
      href: `/robots/${r.robot_id}`,
    });
  }
  for (const w of d.warranty_expiring) {
    items.push({ key: `w-${w.robot_id}`, tone: 'warn', icon: <CalendarClock className="size-5" />, title: <span className="font-mono">{w.robot_id}</span>, sub: `Warranty ends ${fmtDate(w.warranty_end)}`, href: `/robots/${w.robot_id}?tab=dispatch` });
  }
  return items;
}

const ATTENTION_TONE: Record<AttentionTone, string> = { fault: 'bg-fault-bg text-fault', warn: 'bg-warn-bg text-warn', offline: 'bg-offline-bg text-offline' };

export function AttentionList({ items, limit }: { items: AttentionItem[]; limit?: number }) {
  if (items.length === 0) return <EmptyState title="All clear" description="No faults, critical events, offline robots or expiring warranties." />;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      {items.slice(0, limit).map((i) => (
        <li key={i.key}>
          <Link href={i.href} className="flex items-center gap-4 px-5 py-4 hover:bg-surface-2">
            <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', ATTENTION_TONE[i.tone])} aria-hidden>
              {i.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-semibold">{i.title}</span>
              <span className="block truncate text-sm text-muted">{i.sub}</span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ── Fleet map ───────────────────────────────────────────────────────────────

const STATUS_COLOR = { online: '#16a34a', stale: '#d97706', offline: '#6b7280' } as const;

/** Every robot at its last reported position; colour = status. Hover for details, click to open the robot. */
/** `fill`: the card takes the height its parent gives it and the map grows into it (the Fleet map page). */
export function FleetMap({ d, title = 'Fleet map', className, fill }: { d: DashboardDto; title?: string; className?: string; fill?: boolean }) {
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
      title={title}
      className={fill ? 'flex min-h-0 flex-1 flex-col' : undefined}
      bodyClassName={fill ? 'flex min-h-0 flex-1 flex-col p-5' : undefined}
      actions={
        <span className="flex flex-wrap items-center gap-4 text-sm text-muted">
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
          <GeoMap points={points} className={fill ? 'min-h-0 flex-1' : (className ?? 'h-[calc(100dvh-22rem)] min-h-96')} ariaLabel={`Fleet map: ${placed.length} robots with a known position`} onPointClick={(id) => router.push(`/robots/${id}`)} />
          <p className="mt-3 shrink-0 text-sm text-muted">
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

// ── Missions ────────────────────────────────────────────────────────────────

export function MissionsWeek({ d }: { d: DashboardDto }) {
  const m = d.missions_last_7d;
  const total = m.completed + m.failed + m.aborted + m.in_progress;
  return (
    <Card title="Last 7 days" actions={<span className="text-base font-semibold tabular-nums">{total} missions</span>}>
      <ShareBar
        label="Mission results, last 7 days"
        parts={[
          { label: 'Completed', value: m.completed, color: 'var(--chart-good)' },
          { label: 'Aborted', value: m.aborted, color: 'var(--chart-warning)' },
          { label: 'Failed', value: m.failed, color: 'var(--chart-critical)' },
          { label: 'In progress', value: m.in_progress, color: 'var(--accent)' },
        ]}
      />
    </Card>
  );
}

export function RecentMissions({ d }: { d: DashboardDto }) {
  return (
    <Card title="Recent missions" bodyClassName="p-0">
      {d.recent_missions.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No missions yet" description="Missions appear when a robot or the GCS reports one." />
        </div>
      ) : (
        <DataTable
          caption="Recent missions"
          rows={d.recent_missions}
          rowKey={(m) => m.mission_id}
          columns={[
            {
              key: 'id',
              header: 'Mission',
              rowHeader: true,
              cell: (m) => (
                <Link className={cn('block max-w-64 truncate text-accent-text hover:underline', !m.name && 'font-mono')} href={missionHref(m)} title={m.name ? `${m.name} (${m.mission_id})` : m.mission_id}>
                  {m.name ?? m.mission_id}
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
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

export function RecentEvents({ d }: { d: DashboardDto }) {
  return (
    <Card title="Recent events" bodyClassName="p-0">
      {d.recent_events.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No events yet" />
        </div>
      ) : (
        <DataTable
          caption="Recent events"
          rows={d.recent_events}
          rowKey={(e) => e.id}
          columns={[
            { key: 'ts', header: 'Time', cell: (e) => <span className="whitespace-nowrap"><Time iso={e.ts} relative /></span> },
            { key: 'robot', header: 'Robot', cell: (e) => <Link className="font-mono text-accent-text hover:underline" href={`/robots/${e.robot_id}?tab=events`}>{e.robot_id}</Link> },
            { key: 'sev', header: 'Severity', cell: (e) => <SeverityBadge severity={e.severity} /> },
            { key: 'msg', header: 'Message', cell: (e) => <span title={e.message}>{e.message}</span> },
            { key: 'ack', header: 'Acknowledged', cell: (e) => (e.acknowledged_at ? <Badge tone="ok">Yes</Badge> : <span className="text-muted">No</span>) },
          ]}
        />
      )}
    </Card>
  );
}
