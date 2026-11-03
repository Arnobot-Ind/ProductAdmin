'use client';

import type { FleetActivityDayDto, FleetDayActivityDto, RobotDayActivityDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Clock, Film, Package, Route, Siren, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { CalendarLayout, dayTitle, istToday, MonthCalendar } from '@/components/domain/activity-calendar';
import { faultTitle } from '@/components/domain/dashboard';
import { RobotRef } from '@/components/domain/robot-ref';
import { Badge, EmptyState, PageHeader, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { fmtDistance, fmtDuration, humanize } from '@/lib/format';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';

const IST_TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' };
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB', IST_TIME) : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Activity: pick a day on the calendar (left) and see what every robot did that day (right): missions and their
 * results, distance, time on missions, alerts, recordings, software updates, repairs and part changes. Today is shown
 * first; the day is kept in the URL (?day=) so the view can be shared.
 */
export default function ActivityPage() {
  useDocumentTitle('Activity');
  const [params, setParams] = useUrlState();
  const picked = params.get('day');
  const day = picked && /^\d{4}-\d{2}-\d{2}$/.test(picked) ? picked : istToday();
  return (
    <>
      <PageHeader eyebrow="Fleet" title="Activity" description="Pick a day on the calendar to see what each robot did that day." />
      <CalendarLayout calendar={<ActivityMonth day={day} onDay={(d) => setParams({ day: d && d !== istToday() ? d : null })} />}>
        <DayView day={day} />
      </CalendarLayout>
    </>
  );
}

function ActivityMonth({ day, onDay }: { day: string; onDay: (d: string | null) => void }) {
  const [month, setMonth] = useState(day.slice(0, 7));
  const q = useQuery({
    queryKey: ['activity', 'calendar', month],
    queryFn: () => api.get<FleetActivityDayDto[]>('/activity/calendar', { month }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const byDay = new Map((q.data ?? []).map((x) => [x.date, x]));
  return (
    <MonthCalendar
      month={month}
      onMonth={setMonth}
      loading={q.isFetching && !q.data}
      // Shaded by missions; a red dot marks days with critical alerts.
      value={(c) => ({ n: byDay.get(c)?.missions ?? 0, alert: byDay.get(c)?.alerts_critical ?? 0 })}
      label={(n) => plural(n, 'mission')}
      alertLabel="critical alerts"
      day={day}
      onDay={(d) => onDay(d ?? istToday())}
    />
  );
}

function DayView({ day }: { day: string }) {
  const q = useQuery({
    queryKey: ['activity', 'day', day],
    queryFn: () => api.get<FleetDayActivityDto>('/activity/day', { date: day }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  return (
    <section aria-labelledby="day-h" className="grid gap-4">
      <h2 id="day-h" className="text-xl font-semibold">
        {dayTitle(day)}
        {day === istToday() && <span className="ml-2 text-base font-normal text-muted">(today)</span>}
      </h2>
      <QueryView query={q} rows={4}>
        {(d) =>
          d.robots.length === 0 ? (
            <EmptyState title="No robot activity on this day" description="No missions, alerts, recordings, updates or repairs were recorded. Pick another day on the calendar." />
          ) : (
            <>
              <DayTotals d={d} />
              <ul className="grid gap-3">
                {d.robots.map((r) => (
                  <RobotDay key={r.robot_id} r={r} day={day} />
                ))}
              </ul>
            </>
          )
        }
      </QueryView>
    </section>
  );
}

/** The day in five numbers. */
function DayTotals({ d }: { d: FleetDayActivityDto }) {
  const t = d.totals;
  const items: [string, ReactNode, string?][] = [
    ['Robots active', t.robots],
    ['Missions', t.missions, t.missions_bad ? `${t.missions_bad} failed or aborted` : undefined],
    ['Distance', fmtDistance(t.driven_m)],
    ['Time on missions', t.run_s ? fmtDuration(t.run_s) : '—'],
    ['Alerts', t.alerts_critical + t.alerts_warning, t.alerts_critical ? `${t.alerts_critical} critical` : undefined],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm sm:grid-cols-5">
      {items.map(([label, value, sub]) => (
        <div key={label} className="min-w-0">
          <dt className="text-sm text-muted">{label}</dt>
          <dd className="text-xl font-semibold tabular-nums">{value}</dd>
          {sub && <dd className="text-xs font-medium text-fault">{sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** One robot's day: a headline with the numbers, then plain lines for anything else that happened. */
function RobotDay({ r, day }: { r: RobotDayActivityDto; day: string }) {
  const results = [
    r.completed ? `${r.completed} completed` : null,
    r.aborted ? `${r.aborted} aborted` : null,
    r.failed ? `${r.failed} failed` : null,
    r.in_progress ? `${r.in_progress} running` : null,
  ].filter(Boolean);
  const istDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const lastLabel = r.last_at ? `${time(r.last_at)}${istDay(r.last_at) > day ? ' (next day)' : ''}` : null;
  const span = r.first_at && lastLabel ? `${time(r.first_at)} – ${lastLabel}` : r.first_at ? `from ${time(r.first_at)}` : null;
  return (
    <li className="rounded-xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <RobotRef id={r.robot_id} detail={false} className="text-base" />
          <p className="text-sm text-muted">
            {r.category.toUpperCase()} · {r.product_name}
            {r.owner_company ? ` · ${r.owner_company}` : ''}
          </p>
        </div>
        <span className="flex flex-wrap gap-1.5">
          {r.alerts_critical > 0 && <Badge tone="fault">{plural(r.alerts_critical, 'critical alert')}</Badge>}
          {r.alerts_warning > 0 && <Badge tone="warn">{plural(r.alerts_warning, 'warning')}</Badge>}
          {r.alerts_critical + r.alerts_warning === 0 && <Badge tone="ok">No problems</Badge>}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact icon={<Route className="size-4" />} label="Missions" value={r.missions ? `${r.missions}` : '—'} sub={results.join(', ') || undefined} bad={r.aborted + r.failed > 0} />
        <Fact icon={<Route className="size-4" />} label="Distance" value={r.driven_m ? fmtDistance(r.driven_m) : '—'} />
        <Fact icon={<Clock className="size-4" />} label="Time on missions" value={r.run_s ? fmtDuration(r.run_s) : '—'} sub={span ?? undefined} />
        <Fact icon={<Film className="size-4" />} label="Recordings" value={r.recordings ? `${r.recordings}` : '—'} />
      </dl>

      {(r.problems.length > 0 || r.software.length > 0 || r.repairs.length > 0 || r.parts_changed > 0) && (
        <ul className="mt-3 grid gap-1.5 border-t border-border pt-3 text-sm">
          {r.problems.map((p) => (
            <Line key={`${p.code}-${p.message}`} icon={p.severity === 'critical' ? <Siren className="size-4 text-fault" /> : <AlertTriangle className="size-4 text-warn" />}>
              <span className="font-medium">{faultTitle(p.code, humanize(p.type))}</span>
              {p.count > 1 && <span className="font-semibold tabular-nums"> ×{p.count}</span>}
              <span className="text-muted"> · {p.message}</span>
            </Line>
          ))}
          {r.software.map((s) => (
            <Line key={s.at} icon={<Package className="size-4 text-accent-text" />}>
              Software <span className="font-mono font-medium">{s.sw_ver ?? '—'}</span>
              {s.fw_ver && (
                <>
                  , firmware <span className="font-mono font-medium">{s.fw_ver}</span>
                </>
              )}
              <span className="text-muted"> · {time(s.at)}</span>
            </Line>
          ))}
          {r.repairs.map((x, i) => (
            <Line key={i} icon={<Wrench className="size-4 text-accent-text" />}>
              <span className="font-medium">Repair:</span> {x.description} <span className="text-muted">· {x.repaired_by}</span>
            </Line>
          ))}
          {r.parts_changed > 0 && (
            <Line icon={<Wrench className="size-4 text-accent-text" />}>{plural(r.parts_changed, 'hardware part')} fitted or removed</Line>
          )}
        </ul>
      )}

      <Link href={`/robots/${r.robot_id}?tab=missions&day=${day}`} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline">
        Open this robot&apos;s day <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </li>
  );
}

function Fact({ icon, label, value, sub, bad }: { icon: ReactNode; label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-sm text-muted">
        <span aria-hidden>{icon}</span>
        {label}
      </dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {sub && <dd className={bad ? 'text-xs font-medium text-fault' : 'text-xs text-muted'}>{sub}</dd>}
    </div>
  );
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
