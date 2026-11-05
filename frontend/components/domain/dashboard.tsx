'use client';

import { RobotRef } from '@/components/domain/robot-ref';

import type { DashboardDto, FleetReportDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, CalendarClock, ChevronRight, Siren } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { istDay } from '@/components/domain/charts';
import { EmptyState, PageHeader, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtDate, fmtWhen, humanize } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

/** The dashboard (/) and Needs attention read the same /dashboard response, so moving between them is instant. */
/** Missions and distance per IST day over the last `days` days. */
export function useFleetReport(days = 30, enabled = true) {
  const from = istDay(days - 1);
  const to = istDay();
  return useQuery({ queryKey: ['fleet-report', from, to], queryFn: () => api.get<FleetReportDto>('/reports/fleet', { from, to }), staleTime: 300_000, refetchInterval: 600_000, placeholderData: keepPreviousData, enabled });
}

export function useDashboard() {
  const poll = useLivePoll();
  return useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardDto>('/dashboard'), refetchInterval: poll || 300_000 });
}

/** Page frame: title, then the page's one topic. */
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
      icon: f.severity === 'critical' ? <AlertOctagon className="size-4" /> : <AlertTriangle className="size-4" />,
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
      icon: <Siren className="size-4" />,
      title: faultTitle(e.code, humanize(e.type)),
      robotId: e.robot_id,
      message: `${e.message} · ${count > 1 ? `${count} times, ` : ''}not acknowledged`,
      at: e.ts,
      href: `/robots/${e.robot_id}?tab=events&day=${istDayOf(e.ts)}`,
    });
  }
  for (const w of d.warranty_expiring) {
    items.push({ key: `w-${w.robot_id}`, tone: 'warn', icon: <CalendarClock className="size-4" />, title: 'Warranty ending', robotId: w.robot_id, message: `Warranty ends ${fmtDate(w.warranty_end)}`, at: w.warranty_end, href: `/robots/${w.robot_id}?tab=dispatch` });
  }
  return items;
}

const istDayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ATTENTION_TONE: Record<AttentionTone, string> = { fault: 'bg-fault-bg text-fault', warn: 'bg-warn-bg text-warn' };

export function AttentionList({ items, limit, compact }: { items: AttentionItem[]; limit?: number; compact?: boolean }) {
  const now = useNow(30_000);
  if (items.length === 0) return <EmptyState title="All clear" description="No active faults, unacknowledged critical events or warranties ending soon." />;
  return (
    <ul className={cn('divide-y divide-border overflow-hidden', !compact && 'rounded-xl border border-border bg-surface')}>
      {items.slice(0, limit).map((i) => (
        <li key={i.key}>
          <Link href={i.href} className={cn('flex items-center gap-4 hover:bg-surface-2', compact ? 'px-4 py-2' : 'px-4 py-2.5')}>
            <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', ATTENTION_TONE[i.tone])} aria-hidden>
              {i.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-base font-semibold">{i.title}</span>
                <RobotRef id={i.robotId} link={false} detail={false} className="text-sm text-muted" />
                <span className="sr-only">{i.tone === 'fault' ? 'critical' : 'warning'}</span>
              </span>
              <span className={cn('block text-sm text-muted', compact && 'truncate')}>{i.message}</span>
            </span>
            <span className="hidden shrink-0 text-right text-sm text-muted sm:block" title={fmtWhen(i.at, now)}>
              {i.key.startsWith('w-') ? fmtDate(i.at) : fmtAgo(i.at, now)}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
