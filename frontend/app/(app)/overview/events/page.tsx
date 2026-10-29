'use client';

import { RobotRef } from '@/components/domain/robot-ref';

import type { EventCalendarDayDto, EventDto, Paginated } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CalendarLayout, dayBounds, dayTitle, istToday, MonthCalendar } from '@/components/domain/activity-calendar';
import { ShareBar } from '@/components/domain/charts';
import { DashboardPage, RecentEvents } from '@/components/domain/dashboard';
import { SeverityBadge } from '@/components/domain/status';
import { Band } from '@/components/ui/band';
import { Badge, Card, EmptyState, Pagination, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';

/** Severity = state: the reserved status tokens, always shown with their label. */
const SEVERITY = [
  { key: 'critical', label: 'Critical', color: 'var(--chart-critical)' },
  { key: 'warning', label: 'Warning', color: 'var(--chart-warning)' },
  { key: 'info', label: 'Info', color: 'var(--chart-neutral)' },
] as const;

/**
 * Events across the fleet, by calendar: a month on the left, each day shaded by its events (red dot when some were
 * critical). With no day picked, the latest events; pick a day for its severity mix and every event of that day.
 * The day is kept in the URL (?day=). Events are acknowledged on the robot's page.
 */
export default function FleetEventsPage() {
  useDocumentTitle('Events');
  const [params, setParams] = useUrlState();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day') : null;
  const setDay = (d: string | null) => setParams({ day: d });
  return (
    <DashboardPage title="Events" description="Events from every robot, day by day. Open a robot to acknowledge its events.">
      {(d) => <CalendarLayout calendar={<FleetEventCalendar day={day} onDay={setDay} />}>{day ? <DayView day={day} onClear={() => setDay(null)} /> : <RecentEvents d={d} />}</CalendarLayout>}
    </DashboardPage>
  );
}

const eventsLabel = (n: number) => `${n} event${n === 1 ? '' : 's'}`;

function useMonthEvents(month: string) {
  return useQuery({
    queryKey: ['events', 'calendar', month],
    queryFn: () => api.get<EventCalendarDayDto[]>('/events/calendar', { month }),
    placeholderData: keepPreviousData,
    staleTime: 120_000,
  });
}

function FleetEventCalendar({ day, onDay }: { day: string | null; onDay: (d: string | null) => void }) {
  const [month, setMonth] = useState((day ?? istToday()).slice(0, 7));
  const q = useMonthEvents(month);
  const byDay = new Map((q.data ?? []).map((x) => [x.date, x]));
  const picked = day ? byDay.get(day) : undefined;
  return (
    <MonthCalendar
      month={month}
      onMonth={setMonth}
      loading={q.isFetching && !q.data}
      value={(c) => {
        const x = byDay.get(c);
        return { n: x?.total ?? 0, alert: x?.critical ?? 0 };
      }}
      label={eventsLabel}
      alertLabel="critical"
      day={day}
      onDay={onDay}
    >
      {day && (
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-sm font-semibold">{dayTitle(day)}</p>
            <button type="button" onClick={() => onDay(null)} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-text hover:underline">
              <X className="size-3.5" aria-hidden /> All days
            </button>
          </div>
          <ul className="grid gap-1 text-sm">
            <li className="font-semibold">{eventsLabel(picked?.total ?? 0)}</li>
            {SEVERITY.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
                {s.label} <span className="ml-auto font-semibold tabular-nums">{countOf(picked, s.key)}</span>
              </li>
            ))}
            <li className="flex items-center gap-2 text-muted">
              Not acknowledged <span className="ml-auto font-semibold text-fg tabular-nums">{picked?.unacked ?? 0}</span>
            </li>
          </ul>
        </div>
      )}
    </MonthCalendar>
  );
}

/** Info is what is neither critical nor warning. */
function countOf(d: EventCalendarDayDto | undefined, key: (typeof SEVERITY)[number]['key']): number {
  if (!d) return 0;
  return key === 'info' ? Math.max(0, d.total - d.critical - d.warning) : d[key];
}

const LIMIT = 25;

function DayView({ day, onClear }: { day: string; onClear: () => void }) {
  const month = useMonthEvents(day.slice(0, 7));
  const stats = month.data?.find((x) => x.date === day);
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState(day);
  if (shown !== day) {
    setShown(day);
    setPage(1);
  }
  const list = useQuery({
    queryKey: ['events', 'fleet', day, page],
    queryFn: () => api.get<Paginated<EventDto>>('/events', { ...dayBounds(day), page, limit: LIMIT }),
    placeholderData: keepPreviousData,
  });
  const total = stats?.total ?? list.data?.total ?? 0;
  const robots = new Set((list.data?.items ?? []).map((e) => e.robot_id)).size;

  return (
    <div className="flex flex-col gap-6">
      <Band labelledBy="day-h">
        <div className="grid gap-6 p-6 sm:p-8 2xl:grid-cols-[minmax(0,1fr)_auto] 2xl:items-end">
          <div className="min-w-0">
            <p className="text-base text-muted">{dayTitle(day)}</p>
            <h2 id="day-h" className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-5xl leading-none font-semibold">{total}</span>
              <span className="text-xl font-semibold">event{total === 1 ? '' : 's'} across the fleet</span>
            </h2>
            <div className="mt-5 max-w-xl">
              <ShareBar large label={`Events by severity on ${day}`} parts={SEVERITY.map((s) => ({ label: s.label, value: countOf(stats, s.key), color: s.color }))} />
            </div>
          </div>
          <dl className="grid grid-cols-2 divide-x divide-border">
            <div className="pr-6">
              <dt className="text-base text-muted">Not acknowledged</dt>
              <dd className="mt-1 text-3xl font-semibold">{stats?.unacked ?? 0}</dd>
            </div>
            <div className="pl-6">
              <dt className="text-base text-muted">Robots</dt>
              <dd className="mt-1 text-3xl font-semibold">{list.data ? robots : '—'}</dd>
            </div>
          </dl>
        </div>
      </Band>

      <Card
        title="Events on this day"
        actions={
          <button type="button" onClick={onClear} className="inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline">
            <X className="size-4" aria-hidden /> Show all days
          </button>
        }
        bodyClassName="p-0"
      >
        <QueryView query={list} rows={5}>
          {(d) =>
            d.items.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No events on this day" description="Pick another day on the calendar; shaded days have events." />
              </div>
            ) : (
              <>
                <DataTable
                  caption={`Events on ${day}`}
                  rows={d.items}
                  rowKey={(e) => e.id}
                  columns={[
                    { key: 'ts', header: 'Time', cell: (e) => <span className="whitespace-nowrap"><Time iso={e.ts} /></span> },
                    { key: 'robot', header: 'Robot', cell: (e) => <RobotRef id={e.robot_id} href={`/robots/${e.robot_id}?tab=events&day=${day}`} /> },
                    { key: 'sev', header: 'Severity', cell: (e) => <SeverityBadge severity={e.severity} /> },
                    { key: 'msg', header: 'Message', cell: (e) => <span title={e.message}>{e.code ? <span className="mr-2 font-mono text-muted">{e.code}</span> : null}{e.message}</span> },
                    { key: 'ack', header: 'Acknowledged', cell: (e) => (e.acknowledged_at ? <Badge tone="ok">Yes</Badge> : <span className="text-muted">No</span>) },
                  ]}
                />
                <div className="px-5 pb-4">
                  <Pagination page={d.page} limit={d.limit} total={d.total} onPage={setPage} />
                </div>
              </>
            )
          }
        </QueryView>
      </Card>
    </div>
  );
}
