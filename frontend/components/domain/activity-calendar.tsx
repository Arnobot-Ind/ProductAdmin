'use client';

import type { RobotActivityDayDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Card } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtBytes } from '@/lib/format';

/** What a calendar day is shaded by (the open tab's data). */
export type ActivityMetric = 'recordings' | 'detections' | 'missions' | 'events' | 'log';

const METRIC: Record<ActivityMetric, { label: (n: number) => string; alert?: (d: RobotActivityDayDto) => number; alertLabel?: string }> = {
  recordings: { label: (n) => `${n} recording${n === 1 ? '' : 's'}` },
  detections: { label: (n) => `${n} ${n === 1 ? 'person' : 'people'} detected` },
  missions: { label: (n) => `${n} mission${n === 1 ? '' : 's'}`, alert: (d) => d.missions_bad, alertLabel: 'failed or aborted' },
  events: { label: (n) => `${n} event${n === 1 ? '' : 's'}`, alert: (d) => d.events_critical, alertLabel: 'critical' },
  log: { label: (n) => `${n} log entr${n === 1 ? 'y' : 'ies'}`, alert: (d) => d.log_warnings, alertLabel: 'warnings or worse' },
};

const IST = 'Asia/Kolkata';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Today in IST, YYYY-MM-DD. */
export const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: IST });
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthTitle = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const dayTitle = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** Start of an IST day and of the next one, as ISO timestamps for the list APIs' from / to. */
export const dayBounds = (day: string) => ({ from: `${day}T00:00:00+05:30`, to: new Date(new Date(`${day}T00:00:00+05:30`).getTime() + 86_400_000).toISOString() });

/** Shade steps (share of the busiest day this month). Level 0 = nothing that day. */
const SHADES = ['', 'bg-accent/15', 'bg-accent/35', 'bg-accent/60', 'bg-accent text-accent-fg'];
const level = (n: number, max: number) => (n <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));

/**
 * A month of one robot's activity: each IST day is shaded by the open tab's count (recordings, people, missions or
 * events, or log entries), with a red dot for failed missions, critical events or log warnings. Click a day to show only that day; the summary
 * below shows the same day across all four tabs.
 */
export function ActivityCalendar({
  robotId,
  metric,
  day,
  onDay,
  onOpen,
}: {
  robotId: string;
  metric: ActivityMetric;
  day: string | null;
  onDay: (day: string | null) => void;
  /** Open another tab (keeping the day). */
  onOpen?: (metric: ActivityMetric) => void;
}) {
  const today = istToday();
  const thisMonth = today.slice(0, 7);
  const [month, setMonth] = useState((day ?? today).slice(0, 7));
  const q = useQuery({
    queryKey: ['robot', robotId, 'activity', month],
    queryFn: () => api.get<RobotActivityDayDto[]>(`/robots/${robotId}/activity/calendar`, { month }),
    placeholderData: keepPreviousData,
    staleTime: 120_000,
  });
  const byDay = new Map((q.data ?? []).map((d) => [d.date, d]));
  const value = (d: RobotActivityDayDto | undefined) => (d ? d[metric] : 0);
  const max = Math.max(0, ...(q.data ?? []).map((d) => d[metric]));
  const M = METRIC[metric];

  const [y, m] = month.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const total = (q.data ?? []).reduce((n, d) => n + d[metric], 0);
  const active = (q.data ?? []).filter((d) => d[metric] > 0).length;
  const selected = day ? byDay.get(day) : undefined;

  return (
    <Card
      title={monthTitle(month)}
      actions={
        <span className="flex items-center gap-1">
          <NavButton label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            <ChevronLeft className="size-4" />
          </NavButton>
          <NavButton label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))}>
            <ChevronRight className="size-4" />
          </NavButton>
        </span>
      }
      bodyClassName="flex flex-col gap-4 p-4"
    >
      <div>
        <div className="mb-1 grid grid-cols-7 text-center text-xs font-medium text-muted" aria-hidden>
          {WEEKDAYS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div role="grid" aria-label={`${monthTitle(month)}: ${M.label(total)}`} className={cn('grid grid-cols-7 gap-1', q.isFetching && !q.data && 'opacity-50')}>
          {cells.map((c, i) => {
            if (!c) return <span key={`pad-${i}`} />;
            const d = byDay.get(c);
            const n = value(d);
            const alert = d && M.alert ? M.alert(d) : 0;
            const future = c > today;
            const isSel = c === day;
            return (
              <button
                key={c}
                type="button"
                disabled={future}
                aria-pressed={isSel}
                aria-label={`${dayTitle(c)}: ${M.label(n)}${alert ? `, ${alert} ${M.alertLabel}` : ''}`}
                title={`${dayTitle(c)}\n${M.label(n)}${alert ? ` · ${alert} ${M.alertLabel}` : ''}`}
                onClick={() => onDay(isSel ? null : c)}
                className={cn(
                  'relative flex aspect-square flex-col items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                  future ? 'cursor-default text-muted/40' : 'hover:ring-2 hover:ring-accent/40',
                  SHADES[level(n, max)],
                  !n && !future && 'text-muted',
                  c === today && 'font-bold underline underline-offset-2',
                  isSel && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
                )}
              >
                {Number(c.slice(8))}
                {alert > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-fault" aria-hidden />}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted">
          <span>
            {M.label(total)} on {active} day{active === 1 ? '' : 's'}
          </span>
          <span className="inline-flex items-center gap-1" aria-hidden>
            Less
            {SHADES.slice(1).map((s) => (
              <span key={s} className={cn('size-3 rounded-sm', s)} />
            ))}
            More
          </span>
        </div>
      </div>

      {day && (
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-sm font-semibold">{dayTitle(day)}</p>
            <button type="button" onClick={() => onDay(null)} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-text hover:underline">
              <X className="size-3.5" aria-hidden /> All days
            </button>
          </div>
          <ul className="grid gap-1 text-sm">
            <DayLine on={metric === 'recordings'} onOpen={onOpen && (() => onOpen('recordings'))}>
              {METRIC.recordings.label(selected?.recordings ?? 0)}
              {selected?.recording_bytes ? <span className="text-muted"> · {fmtBytes(selected.recording_bytes)}</span> : null}
            </DayLine>
            <DayLine on={metric === 'detections'} onOpen={onOpen && (() => onOpen('detections'))}>
              {METRIC.detections.label(selected?.detections ?? 0)}
            </DayLine>
            <DayLine on={metric === 'missions'} onOpen={onOpen && (() => onOpen('missions'))}>
              {METRIC.missions.label(selected?.missions ?? 0)}
              {selected?.missions_bad ? <span className="text-fault"> · {selected.missions_bad} failed or aborted</span> : null}
            </DayLine>
            <DayLine on={metric === 'events'} onOpen={onOpen && (() => onOpen('events'))}>
              {METRIC.events.label(selected?.events ?? 0)}
              {selected?.events_critical ? <span className="text-fault"> · {selected.events_critical} critical</span> : null}
            </DayLine>
            <DayLine on={metric === 'log'} onOpen={onOpen && (() => onOpen('log'))}>
              {METRIC.log.label(selected?.log ?? 0)}
              {selected?.log_warnings ? <span className="text-fault"> · {selected.log_warnings} warnings</span> : null}
            </DayLine>
          </ul>
        </div>
      )}
      {!day && <p className="text-xs text-muted">Pick a day to see only that day. Times are IST.</p>}
    </Card>
  );
}

function NavButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

function DayLine({ on, onOpen, children }: { on: boolean; onOpen?: () => void; children: ReactNode }) {
  return (
    <li>
      {on || !onOpen ? (
        <span className={cn('block px-1', on && 'font-semibold')}>{children}</span>
      ) : (
        <button type="button" onClick={onOpen} className="w-full rounded px-1 text-left hover:bg-surface hover:text-accent-text">
          {children}
        </button>
      )}
    </li>
  );
}

/** Calendar on the left (sticky on wide screens), the day's data on the right; stacked on phones. */
export function CalendarLayout({ calendar, children }: { calendar: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
      <aside className="lg:sticky lg:top-20">{calendar}</aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
