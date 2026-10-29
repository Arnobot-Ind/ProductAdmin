'use client';

import { RobotRef } from '@/components/domain/robot-ref';

import type { DashboardDto, FleetReportDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, CalendarClock, ChevronRight, Siren } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRobotDirectory } from '@/components/domain/robot-ref';
import { useMemo, type ReactNode } from 'react';
import { istDay, ShareBar } from '@/components/domain/charts';
import { GeoMap } from '@/components/domain/geo-map';
import { missionHref } from '@/components/domain/missions-table';
import { MissionResultBadge, SeverityBadge } from '@/components/domain/status';
import { Badge, Card, EmptyState, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDate, fmtWhen, humanize } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

/**
 * The dashboard, one topic per page: Summary (/), Needs attention, Fleet map, Missions and Events (/overview/*).
 * Every page reads the same /dashboard response, so moving between them is instant.
 */
/** Missions and distance per IST day and per robot over the last `days` days (the same report the client portal uses). */
export function useFleetReport(days = 30, enabled = true) {
  const from = istDay(days - 1);
  const to = istDay();
  return useQuery({ queryKey: ['fleet-report', from, to], queryFn: () => api.get<FleetReportDto>('/reports/fleet', { from, to }), staleTime: 300_000, refetchInterval: 600_000, enabled });
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

type AttentionTone = 'fault' | 'warn';
export interface AttentionItem {
  key: string;
  tone: AttentionTone;
  icon: ReactNode;
  /** What is wrong, in words (e.g. "Emergency stop"). */
  title: string;
  robotId: string;
  message: string;
  at: string;
  href: string;
}

/** A fault code as words: EMERGENCY_STOP → "Emergency stop". */
export const faultTitle = (code: string | null, fallback: string) => (code ? humanize(code.toLowerCase()) : fallback);

/**
 * What needs someone now, most urgent first: every fault or alert still active (critical first), then
 * critical events nobody has acknowledged that are not already covered by an active fault, then warranties ending soon.
 * The problems themselves, not a list of robots.
 */
export function attentionItems(d: DashboardDto): AttentionItem[] {
  const items: AttentionItem[] = [];
  const active = new Set(d.active_faults.map((f) => f.event_id));
  for (const f of d.active_faults) {
    items.push({
      key: `f-${f.event_id}`,
      tone: f.severity === 'critical' ? 'fault' : 'warn',
      icon: f.severity === 'critical' ? <AlertOctagon className="size-5" /> : <AlertTriangle className="size-5" />,
      title: faultTitle(f.code, 'Fault'),
      robotId: f.robot_id,
      message: f.message,
      at: f.since,
      href: `/robots/${f.robot_id}?tab=health`,
    });
  }
  // The same problem reported again and again (e.g. a controller that keeps dropping) is one line with a count.
  for (const { latest: e, count } of d.critical_event_groups.filter((g) => !active.has(g.latest.id))) {
    items.push({
      key: `e-${e.id}`,
      tone: 'fault',
      icon: <Siren className="size-5" />,
      title: faultTitle(e.code, humanize(e.type)),
      robotId: e.robot_id,
      message: `${e.message} · ${count > 1 ? `${count} times, ` : ''}not acknowledged`,
      at: e.ts,
      href: `/robots/${e.robot_id}?tab=events&day=${istDayOf(e.ts)}`,
    });
  }
  for (const w of d.warranty_expiring) {
    items.push({ key: `w-${w.robot_id}`, tone: 'warn', icon: <CalendarClock className="size-5" />, title: 'Warranty ending', robotId: w.robot_id, message: `Warranty ends ${fmtDate(w.warranty_end)}`, at: w.warranty_end, href: `/robots/${w.robot_id}?tab=dispatch` });
  }
  return items;
}

const istDayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ATTENTION_TONE: Record<AttentionTone, string> = { fault: 'bg-fault-bg text-fault', warn: 'bg-warn-bg text-warn' };

export function AttentionList({ items, limit, compact }: { items: AttentionItem[]; limit?: number; compact?: boolean }) {
  const now = useNow(30_000);
  if (items.length === 0) return <EmptyState title="All clear" description="No active faults, unacknowledged critical events or warranties ending soon." />;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      {items.slice(0, limit).map((i) => (
        <li key={i.key}>
          <Link href={i.href} className={cn('flex items-center gap-4 hover:bg-surface-2', compact ? 'px-4 py-3' : 'px-5 py-4')}>
            <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', ATTENTION_TONE[i.tone])} aria-hidden>
              {i.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-base font-semibold">{i.title}</span>
                <RobotRef id={i.robotId} link={false} detail={false} className="text-sm text-accent-text" />
                <span className="sr-only">{i.tone === 'fault' ? 'critical' : 'warning'}</span>
              </span>
              <span className={cn('block text-sm text-muted', compact && 'truncate')}>{i.message}</span>
            </span>
            <span className="hidden shrink-0 text-right text-sm text-muted sm:block" title={fmtWhen(i.at, now)}>
              {i.key.startsWith('w-') ? fmtDate(i.at) : fmtAgo(i.at, now)}
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
  const dir = useRobotDirectory();
  const placed = d.fleet.filter((r) => r.lat !== null && r.lon !== null);
  const points = useMemo(
    () =>
      placed.map((r) => ({
        id: r.robot_id,
        lat: r.lat!,
        lon: r.lon!,
        color: STATUS_COLOR[r.status],
        label: [
          `${r.robot_id}${dir.get(r.robot_id)?.nickname ? ` · ${dir.get(r.robot_id)!.nickname}` : ''}`,
          `${r.category.toUpperCase()} · ${r.product_name}`,
          dir.get(r.robot_id)?.attachments.length ? dir.get(r.robot_id)!.attachments.join(', ') : null,
          `${r.status}${r.battery_pct !== null ? ` · ${Math.round(r.battery_pct)} %` : ''}`,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(placed), dir],
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
          <GeoMap points={points} className={fill ? 'min-h-0 flex-1' : (className ?? 'h-[calc(100dvh-22rem)] min-h-96')} ariaLabel={`Fleet map: ${placed.length} robots with a known position`} onPointClick={(id) => router.push(`/robots/${id}`)} cluster={placed.length > 30} />
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
            { key: 'robot', header: 'Robot', cell: (m) => <RobotRef id={m.robot_id} href={`/robots/${m.robot_id}?tab=missions`} /> },
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
            { key: 'robot', header: 'Robot', cell: (e) => <RobotRef id={e.robot_id} href={`/robots/${e.robot_id}?tab=events`} /> },
            { key: 'sev', header: 'Severity', cell: (e) => <SeverityBadge severity={e.severity} /> },
            { key: 'msg', header: 'Message', cell: (e) => <span title={e.message}>{e.message}</span> },
            { key: 'ack', header: 'Acknowledged', cell: (e) => (e.acknowledged_at ? <Badge tone="ok">Yes</Badge> : <span className="text-muted">No</span>) },
          ]}
        />
      )}
    </Card>
  );
}
