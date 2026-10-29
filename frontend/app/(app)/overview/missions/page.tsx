'use client';

import type { FleetReportDto, MissionListItemDto, Paginated } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CalendarLayout, dayBounds, dayTitle, istToday, MonthCalendar } from '@/components/domain/activity-calendar';
import { MissionsPerDayChart, RankBars, RESULTS, ShareBar } from '@/components/domain/charts';
import { DashboardPage, MissionsWeek, RecentMissions, useFleetReport } from '@/components/domain/dashboard';
import { missionHref } from '@/components/domain/missions-table';
import { MissionResultBadge } from '@/components/domain/status';
import { Band } from '@/components/ui/band';
import { Card, EmptyState, Pagination, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtDuration } from '@/lib/format';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';

type Day = FleetReportDto['daily'][number];

/**
 * Missions across the fleet, by calendar: a month on the left, each day shaded by its missions (red dot when some
 * failed or were aborted). With no day picked, the 7- and 30-day overview; pick a day for that day's results and
 * every mission flown on it. The day is kept in the URL (?day=), so the view can be shared.
 */
export default function FleetMissionsPage() {
  useDocumentTitle('Missions');
  const [params, setParams] = useUrlState();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day') : null;
  const setDay = (d: string | null) => setParams({ day: d });
  return (
    <DashboardPage title="Missions" description="Mission results across the fleet, day by day. Each robot's own missions are on its page, under Recordings.">
      {(d) => (
        <CalendarLayout calendar={<FleetMissionCalendar day={day} onDay={setDay} />}>
          {day ? (
            <DayView day={day} onClear={() => setDay(null)} />
          ) : (
            <div className="flex flex-col gap-6">
              <MissionsWeek d={d} />
              <LastThirtyDays />
              <RecentMissions d={d} />
            </div>
          )}
        </CalendarLayout>
      )}
    </DashboardPage>
  );
}

// ── calendar ────────────────────────────────────────────────────────────────

const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const missionsLabel = (n: number) => `${n} mission${n === 1 ? '' : 's'}`;

/** A month of fleet missions (the fleet report for that month: one request, per IST day). */
function useMonthReport(month: string) {
  return useQuery({
    queryKey: ['fleet-report', `${month}-01`, monthEnd(month)],
    queryFn: () => api.get<FleetReportDto>('/reports/fleet', { from: `${month}-01`, to: monthEnd(month) }),
    placeholderData: keepPreviousData,
    staleTime: 300_000,
  });
}

function FleetMissionCalendar({ day, onDay }: { day: string | null; onDay: (d: string | null) => void }) {
  const [month, setMonth] = useState((day ?? istToday()).slice(0, 7));
  const q = useMonthReport(month);
  const byDay = new Map((q.data?.daily ?? []).map((x) => [x.date, x]));
  const picked = day ? byDay.get(day) : undefined;
  return (
    <MonthCalendar
      month={month}
      onMonth={setMonth}
      loading={q.isFetching && !q.data}
      value={(c) => {
        const x = byDay.get(c);
        return { n: x?.missions ?? 0, alert: x ? x.aborted + x.failed : 0 };
      }}
      label={missionsLabel}
      alertLabel="failed or aborted"
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
            <li className="font-semibold">{missionsLabel(picked?.missions ?? 0)}</li>
            {RESULTS.map((r) => (
              <li key={r.key} className="flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: r.color }} aria-hidden />
                {r.label} <span className="ml-auto font-semibold tabular-nums">{picked?.[r.key] ?? 0}</span>
              </li>
            ))}
            <li className="flex items-center gap-2 text-muted">
              Distance driven <span className="ml-auto font-semibold text-fg tabular-nums">{fmtDistance(picked?.driven_m ?? 0)}</span>
            </li>
          </ul>
        </div>
      )}
    </MonthCalendar>
  );
}

// ── no day picked: the overview ─────────────────────────────────────────────

function LastThirtyDays() {
  const report = useFleetReport(30);
  return (
    <QueryView query={report} rows={4}>
      {(r) => (
        <div className="grid gap-6 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card title="Missions per day · last 30 days" actions={<span className="text-base font-semibold tabular-nums">{r.totals.total} missions</span>}>
            <MissionsPerDayChart rows={r.daily} />
          </Card>
          <Card title="Missions per robot · last 30 days">
            <RankBars
              rows={r.robots.map((x) => ({ key: x.robot_id, label: x.robot_id, value: x.missions.total, display: String(x.missions.total), detail: `${x.robot_id}: ${x.missions.total} missions, ${x.missions.completed} completed` }))}
              empty="No missions in the last 30 days."
            />
          </Card>
        </div>
      )}
    </QueryView>
  );
}

// ── one day ─────────────────────────────────────────────────────────────────

const LIMIT = 25;

function DayView({ day, onClear }: { day: string; onClear: () => void }) {
  const report = useMonthReport(day.slice(0, 7));
  const stats: Day | undefined = report.data?.daily.find((x) => x.date === day);
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState(day);
  if (shown !== day) {
    setShown(day);
    setPage(1);
  }
  const list = useQuery({
    queryKey: ['missions', 'fleet', day, page],
    queryFn: () => api.get<Paginated<MissionListItemDto>>('/missions', { ...dayBounds(day), page, limit: LIMIT }),
    placeholderData: keepPreviousData,
  });
  const robots = new Set((list.data?.items ?? []).map((m) => m.robot_id)).size;
  const total = stats?.missions ?? list.data?.total ?? 0;
  const inProgress = Math.max(0, total - (stats ? stats.completed + stats.aborted + stats.failed : 0));

  return (
    <div className="flex flex-col gap-6">
      {/* The day's headline on the brand band, as on the dashboard. */}
      <Band labelledBy="day-h">
        <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <p className="text-base text-muted">{dayTitle(day)}</p>
            <h2 id="day-h" className="mt-2 flex items-baseline gap-3">
              <span className="text-5xl leading-none font-semibold">{total}</span>
              <span className="text-xl font-semibold">mission{total === 1 ? '' : 's'} across the fleet</span>
            </h2>
            <div className="mt-5 max-w-xl">
              <ShareBar
                large
                label={`Mission results on ${day}`}
                parts={[
                  ...RESULTS.map((r) => ({ label: r.label, value: stats?.[r.key] ?? 0, color: r.color })),
                  ...(inProgress ? [{ label: 'In progress', value: inProgress, color: 'var(--accent)' }] : []),
                ]}
              />
            </div>
          </div>
          <dl className="grid grid-cols-2 divide-x divide-border">
            <div className="pr-6">
              <dt className="text-base text-muted">Distance driven</dt>
              <dd className="mt-1 text-3xl font-semibold">{fmtDistance(stats?.driven_m ?? 0)}</dd>
            </div>
            <div className="pl-6">
              <dt className="text-base text-muted">Robots active</dt>
              <dd className="mt-1 text-3xl font-semibold">{list.data ? robots : '—'}</dd>
            </div>
          </dl>
        </div>
      </Band>

      <Card
        title="Missions on this day"
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
                <EmptyState title="No missions on this day" description="Pick another day on the calendar; shaded days have missions." />
              </div>
            ) : (
              <>
                <DataTable
                  caption={`Missions on ${day}`}
                  rows={d.items}
                  rowKey={(m) => m.mission_id}
                  columns={[
                    {
                      key: 'name',
                      header: 'Mission',
                      rowHeader: true,
                      cell: (m) => (
                        <Link className={cn('block max-w-72 truncate text-accent-text hover:underline', !m.name && 'font-mono')} href={missionHref(m)} title={m.name ? `${m.name} (${m.mission_id})` : m.mission_id}>
                          {m.name ?? m.mission_id}
                        </Link>
                      ),
                    },
                    { key: 'robot', header: 'Robot', cell: (m) => <Link className="font-mono text-accent-text hover:underline" href={`/robots/${m.robot_id}?tab=missions&day=${day}`}>{m.robot_id}</Link> },
                    { key: 'start', header: 'Started', cell: (m) => <span className="whitespace-nowrap"><Time iso={m.started_at} /></span> },
                    { key: 'dur', header: 'Duration', cell: (m) => <span className="whitespace-nowrap tabular-nums">{fmtDuration(m.duration_s)}</span> },
                    { key: 'dist', header: 'Distance', cell: (m) => <span className="whitespace-nowrap tabular-nums">{fmtDistance(m.distance_m)}</span> },
                    { key: 'res', header: 'Result', cell: (m) => <MissionResultBadge result={m.result} /> },
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
