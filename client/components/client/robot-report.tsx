'use client';

import { CLIENT_FEATURES, type ClientMissionDto, type ClientMissionReportDto, type ClientMissionsDto, type DayReportDto, type ReportCalendarDayDto, type RobotDetailDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarRange, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download, FileDown, MapPin, Moon, Route, Spline, XCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Card, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useFeature } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtDuration } from '@/lib/format';
import { downloadPatrolReport } from '@/lib/patrol-report';
import { downloadDaySummary, downloadMissionReport, downloadMonthSummary, PATROL_WINDOWS, patrolRange, type PatrolWindowId } from '@/lib/robot-reports';
import { MissionResultBadge, istDay, istHm } from './robot-missions';

// Leaflet is client-only.
const ReportMap = dynamic(() => import('@/components/client/report-map').then((m) => m.ReportMap), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading map…</div>,
});

const endHm = (iso: string) => (istHm(iso) === '00:00' ? '24:00' : istHm(iso));
const kmh = (mps: number | null) => (mps === null ? '—' : (mps * 3.6).toFixed(1));
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)} %`);
const loggedLabel = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} m` : `${min} m`);
const dayTitle = (date: string) =>
  new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Runs a download with a loading flag and a toast. */
function useDownload() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) toast.success(msg);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/**
 * Reports tab of the client robot page, laid out like the GCS's report calendar: pick a day on the month calendar
 * (badges = missions and time logged), then that day's reports. Only four reports: mission report, day summary,
 * monthly summary and the night surveillance log. All times IST.
 */
/** PDF downloads need portal.reports.download (0021); the reports themselves stay viewable on screen. */
export function useCanDownloadReports(): boolean {
  return useFeature()(CLIENT_FEATURES.reportsDownload);
}

export function RobotReportsTab({ robot }: { robot: RobotDetailDto }) {
  const canDownload = useCanDownloadReports();
  const today = istDay();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const cal = useQuery({
    queryKey: ['robot', robot.robot_id, 'report-calendar', month],
    queryFn: () => api.get<ReportCalendarDayDto[]>(`/robots/${robot.robot_id}/reports/calendar`, { month }),
    placeholderData: keepPreviousData,
  });
  // Opening the tab or moving to another month selects today when it has data, else the month's latest day with
  // data (so a robot that last worked days ago does not open on an empty day).
  useEffect(() => {
    if (!cal.data || (selected && selected.startsWith(month))) return;
    const withData = cal.data.filter((d) => d.date.startsWith(month) && (d.missions > 0 || d.online_min > 0));
    const fallback = month === today.slice(0, 7) ? today : `${month}-01`;
    setSelected(withData.some((d) => d.date === today) ? today : (withData[withData.length - 1]?.date ?? fallback));
  }, [cal.data, month, selected, today]);

  const shift = (delta: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  const day = selected && cal.data?.find((d) => d.date === selected);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
      <div className="flex flex-col gap-3 lg:sticky lg:top-4">
        <MonthCalendar
          month={month}
          days={cal.data ?? []}
          loading={cal.isFetching}
          today={today}
          selected={selected}
          onSelect={setSelected}
          onPrev={() => shift(-1)}
          onNext={() => shift(1)}
          canNext={month < today.slice(0, 7)}
        />
        {cal.error && <ErrorState error={cal.error} onRetry={() => void cal.refetch()} />}
        {canDownload && <MonthSummaryButton robot={robot} month={month} />}
      </div>
      {selected ? (
        <DayPanel key={selected} robot={robot} date={selected} day={day || null} />
      ) : (
        <EmptyState title="Pick a day" description="Choose a day on the calendar to see its missions and reports." />
      )}
    </div>
  );
}

// ── month calendar (port of the GCS MonthCalendar) ──────────────────────────
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function MonthCalendar(props: {
  month: string;
  days: ReportCalendarDayDto[];
  loading: boolean;
  today: string;
  selected: string | null;
  onSelect: (date: string) => void;
  onPrev: () => void;
  onNext: () => void;
  canNext: boolean;
}) {
  const { month, days, loading, today, selected, onSelect, onPrev, onNext, canNext } = props;
  const [y, m] = month.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const cells: (number | null)[] = [...Array<null>(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const title = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const navBtn = 'rounded-md border border-border bg-surface-2 p-1.5 text-muted hover:text-fg disabled:opacity-40';

  return (
    <section aria-label="Reports calendar" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between">
        <button type="button" onClick={onPrev} className={navBtn} aria-label="Previous month" title="Previous month">
          <ChevronLeft className="size-3.5" aria-hidden />
        </button>
        <span className="text-sm font-semibold">
          {title}
          {loading && <span className="ml-2 text-[11px] font-normal text-muted">loading…</span>}
        </span>
        <button type="button" onClick={onNext} disabled={!canNext} className={navBtn} aria-label="Next month" title="Next month">
          <ChevronRight className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1" aria-hidden>
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center text-[11px] tracking-wide text-muted uppercase">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />;
          const date = `${month}-${String(d).padStart(2, '0')}`;
          const info = byDate.get(date);
          const missions = info?.missions ?? 0;
          const logged = info?.online_min ?? 0;
          const has = missions > 0 || logged > 0;
          const isSel = selected === date;
          const isToday = date === today;
          const future = date > today;
          const bad = (info?.aborted ?? 0) + (info?.failed ?? 0);
          const tip = has ? [missions ? `${missions} mission${missions > 1 ? 's' : ''}` : null, logged ? `${loggedLabel(logged)} logged` : null].filter(Boolean).join(' · ') : 'No data';
          return (
            <button
              key={date}
              type="button"
              disabled={future}
              onClick={() => onSelect(date)}
              title={tip}
              aria-label={`${dayTitle(date)}: ${tip}`}
              aria-pressed={isSel}
              className={cn(
                'relative flex aspect-square flex-col items-center justify-center rounded-md border text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-30',
                isSel
                  ? 'border-accent bg-accent text-accent-fg shadow-sm'
                  : has
                    ? 'border-border bg-accent-soft hover:border-accent'
                    : 'border-border/60 bg-surface hover:bg-surface-2',
                isToday && !isSel && 'border-accent',
              )}
            >
              <span className={cn(isToday || isSel ? 'font-bold' : 'font-medium', !has && !isSel && 'opacity-55')}>{d}</span>
              {missions > 0 && (
                <span
                  className={cn(
                    'absolute top-0.5 right-0.5 min-w-3.5 rounded-full px-1 text-center text-[10px] leading-tight font-bold',
                    isSel ? 'bg-accent-fg text-accent' : 'bg-accent text-accent-fg',
                  )}
                >
                  {missions}
                </span>
              )}
              {has && (
                <span className="absolute bottom-0.5 flex items-center gap-0.5" aria-hidden>
                  {logged > 0 && <span className={cn('size-1.5 rounded-full', isSel ? 'bg-accent-fg' : 'bg-accent')} />}
                  {(info?.completed ?? 0) > 0 && <span className="size-1.5 rounded-full bg-ok" />}
                  {bad > 0 && <span className="size-1.5 rounded-full bg-fault" />}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex min-w-3.5 justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-fg">3</span> missions
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-accent" /> logged
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-ok" /> completed
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-fault" /> aborted / failed
        </span>
      </div>
    </section>
  );
}

function MonthSummaryButton({ robot, month }: { robot: RobotDetailDto; month: string }) {
  const { busy, run } = useDownload();
  const label = new Date(`${month}-15T12:00:00+05:30`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return (
    <Button
      icon={<CalendarRange className="size-4" aria-hidden />}
      loading={busy}
      onClick={() => void run(async () => `Monthly summary downloaded (${await downloadMonthSummary(robot, month)} missions)`)}
    >
      Monthly summary · {label} (PDF)
    </Button>
  );
}

// ── the selected day ────────────────────────────────────────────────────────
function DayPanel({ robot, date, day }: { robot: RobotDetailDto; date: string; day: ReportCalendarDayDto | null }) {
  const canDownload = useCanDownloadReports();
  const daySum = useDownload();
  const missions = useQuery({
    queryKey: ['robot', robot.robot_id, 'report-missions', date],
    queryFn: () => api.get<ClientMissionsDto>(`/robots/${robot.robot_id}/reports/missions`, { from: date, to: date, limit: 200 }),
  });
  const items = [...(missions.data?.items ?? [])].reverse(); // oldest first within the day
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((m) => m.mission_id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{dayTitle(date)}</h2>
          <p className="text-sm text-muted">
            {day
              ? [
                  `${day.missions} mission${day.missions === 1 ? '' : 's'}`,
                  day.online_min ? `${loggedLabel(day.online_min)} logged` : 'no data logged',
                  day.driven_m ? `${fmtDistance(day.driven_m)} driven` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : '—'}
          </p>
        </div>
        {canDownload && (
          <Button
            variant="primary"
            icon={<FileDown className="size-4" aria-hidden />}
            loading={daySum.busy}
            onClick={() => void daySum.run(async () => `Day summary downloaded (${await downloadDaySummary(robot, date)} missions)`)}
          >
            Day summary (PDF)
          </Button>
        )}
      </div>

      <Card title={`Missions${missions.data ? ` (${missions.data.total})` : ''}`} bodyClassName="p-0">
        {missions.isLoading ? (
          <div className="p-4">
            <LoadingBlock rows={3} label="Loading missions" />
          </div>
        ) : missions.error ? (
          <div className="p-4">
            <ErrorState error={missions.error} onRetry={() => void missions.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-muted">No missions on this day.</p>
        ) : (
          <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto p-2">
            {items.map((m) => (
              <MissionRow key={m.mission_id} m={m} active={m.mission_id === selectedId} onSelect={() => setSelectedId(m.mission_id === selectedId ? null : m.mission_id)} />
            ))}
          </ul>
        )}
      </Card>

      {selected ? (
        <MissionDetail key={selected.mission_id} robot={robot} missionId={selected.mission_id} />
      ) : items.length > 0 ? (
        <p className="-mt-2 text-sm text-muted">Select a mission to view it on the map.</p>
      ) : null}

      <PatrolLog robot={robot} date={date} />
    </div>
  );
}

/** One mission of the day, as the GCS Mission Reports list: status icon, name, status; time · distance · duration · waypoints. */
function MissionRow({ m, active, onSelect }: { m: ClientMissionDto; active: boolean; onSelect: () => void }) {
  const ok = m.result === 'completed';
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          'w-full rounded-md border border-l-[3px] px-3 py-2 text-left transition-colors',
          active ? 'border-accent bg-accent/10' : cn('border-border bg-surface-2 hover:border-accent/50', ok ? 'border-l-ok' : 'border-l-fault'),
        )}
      >
        <div className="flex items-center gap-1.5">
          {ok ? <CheckCircle2 className="size-3.5 shrink-0 text-ok" aria-hidden /> : <XCircle className="size-3.5 shrink-0 text-fault" aria-hidden />}
          <span className="truncate text-sm font-semibold">{m.name || 'Mission'}</span>
          <span className={cn('ml-auto text-[11px] uppercase', ok ? 'text-ok' : 'text-fault')}>{m.result === 'in_progress' ? 'in progress' : m.result}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted tabular-nums">
          <span>{istHm(m.started_at)} IST</span>
          <span>· {fmtDistance(m.distance_m)}</span>
          <span>· {fmtDuration(m.duration_s)}</span>
          {m.waypoints_total !== null && (
            <span>
              · {m.waypoints_reached ?? 0}/{m.waypoints_total} wp
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

/** The selected mission on the map with its figures and the PDF download, as the GCS Mission Reports detail. */
function MissionDetail({ robot, missionId }: { robot: RobotDetailDto; missionId: string }) {
  const canDownload = useCanDownloadReports();
  const { busy, run } = useDownload();
  const [showTrack, setShowTrack] = useState(true);
  const q = useQuery({
    queryKey: ['robot', robot.robot_id, 'mission-report', missionId],
    queryFn: () => api.get<ClientMissionReportDto>(`/robots/${robot.robot_id}/reports/missions/${encodeURIComponent(missionId)}`),
  });
  if (q.isLoading) return <LoadingBlock rows={4} label="Loading mission" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const m = q.data!;
  const ok = m.result === 'completed';
  const waypoints = m.waypoints ?? [];
  const path = m.path ?? [];
  return (
    <section aria-label={`Mission ${m.name ?? ''}`} className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-semibold">{m.name || 'Mission'}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] uppercase', ok ? 'bg-ok/15 text-ok' : 'bg-fault/15 text-fault')}>
          {m.result === 'in_progress' ? 'in progress' : m.result}
        </span>
        <Stat icon={<Route className="size-3" />} label="Covered" value={`${fmtDistance(m.distance_m)} / ${fmtDistance(m.distance_planned_m)}`} />
        <Stat icon={<Clock className="size-3" />} label="Time" value={fmtDuration(m.duration_s)} />
        <Stat icon={<MapPin className="size-3" />} label="Waypoints" value={m.waypoints_total === null ? '—' : `${m.waypoints_reached ?? 0}/${m.waypoints_total}`} />
        {path.length > 1 && (
          <button
            type="button"
            onClick={() => setShowTrack((v) => !v)}
            aria-pressed={showTrack}
            title={showTrack ? 'Hide the actual driven path' : 'Show the actual driven path'}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold',
              showTrack ? 'border-[#FF9F0A] bg-[#FF9F0A]/15 text-[#b86e00] dark:text-[#FF9F0A]' : 'border-border text-muted',
            )}
          >
            <Spline className="size-3" aria-hidden /> Actual path · {path.length} pts
          </button>
        )}
        {canDownload && (
          <Button size="sm" className="ml-auto" icon={<Download className="size-4" aria-hidden />} loading={busy} onClick={() => void run(() => downloadMissionReport(robot, m.mission_id))}>
            Download
          </Button>
        )}
      </div>
      <div className="px-4 py-1.5 text-xs text-muted tabular-nums">
        {istHm(m.started_at)} – {istHm(m.ended_at)} IST{m.end_reason ? ` · ${m.end_reason}` : ''}
      </div>
      {waypoints.length || path.length > 1 ? (
        <div style={{ height: 460 }}>
          <ReportMap waypoints={waypoints} missionPath={path} showMissionPath={showTrack} height="100%" />
        </div>
      ) : (
        <p className="px-4 pb-4 text-sm text-muted">This mission has no waypoints or recorded path to draw.</p>
      )}
    </section>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted" aria-hidden>
        {icon}
      </span>
      <span className="text-[11px] tracking-wide text-muted uppercase">{label}</span>
      <span className="font-mono text-[11px] font-semibold">{value}</span>
    </span>
  );
}

// ── night surveillance log of the day (with an on-screen preview) ───────────
function PatrolLog({ robot, date }: { robot: RobotDetailDto; date: string }) {
  const canDownload = useCanDownloadReports();
  const { busy, run } = useDownload();
  const [windowId, setWindowId] = useState<PatrolWindowId>('night');
  const [from, setFrom] = useState('22:00');
  const [to, setTo] = useState('06:00');
  const range = patrolRange(windowId, from, to);
  const ready = !!range.from && !!range.to;
  const q = useQuery({
    queryKey: ['robot', robot.robot_id, 'day-report', date, range.from, range.to],
    queryFn: () => api.get<DayReportDto>(`/robots/${robot.robot_id}/reports/day`, { date, ...range }),
    enabled: ready,
    placeholderData: keepPreviousData,
  });

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Moon className="size-4" aria-hidden /> Night surveillance log
        </span>
      }
      actions={
        canDownload && (
          <Button variant="primary" size="sm" icon={<FileDown className="size-4" aria-hidden />} onClick={() => void run(() => downloadPatrolReport(q.data!))} loading={busy} disabled={!q.data}>
            Download PDF
          </Button>
        )
      }
    >
      {/* One row of equal-height fields; the explanations sit under the row so they never push a field down. */}
      <form className="mb-5" onSubmit={(e) => e.preventDefault()}>
        <div className="flex flex-wrap items-start gap-3">
          <Field label="Period" className="w-full sm:w-72">
            <Select value={windowId} onChange={(e) => setWindowId(e.target.value as PatrolWindowId)}>
              {PATROL_WINDOWS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
          {windowId === 'custom' && (
            <>
              <Field label="From (IST)" className="w-[calc(50%-0.375rem)] sm:w-36">
                <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} required />
              </Field>
              <Field label="To (IST)" className="w-[calc(50%-0.375rem)] sm:w-36">
                <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} required />
              </Field>
            </>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">
          Starts on the selected day. A night period runs from this evening to the next morning
          {windowId === 'custom' ? '; a To time earlier than From ends on the next day.' : '.'}
        </p>
      </form>
      {q.isLoading ? (
        <LoadingBlock rows={6} label="Loading log" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <ReportBody r={q.data} />
      ) : null}
    </Card>
  );
}

function ReportBody({ r }: { r: DayReportDto }) {
  const s = r.summary;
  if (s.online_s === 0) {
    return <EmptyState title="No data for this period" description={`${r.robot_name} did not report to the portal between ${istHm(r.from)} and ${endHm(r.to)} IST.`} />;
  }
  const tiles: [string, string][] = [
    ['Distance patrolled', s.distance_source === 'none' ? '—' : fmtDistance(s.distance_m)],
    ['Robot online', fmtDuration(s.online_s)],
    ['Time on the move', `${Math.round(s.moving_s / 60)} min · ${Math.round((s.moving_s / s.online_s) * 100)}%`],
    ['Peak / avg speed', `${kmh(s.peak_mps)} / ${kmh(s.avg_moving_mps)} km/h`],
    ['GPS fix (reliable)', pct(s.gps_reliable_pct)],
    ['Satellites (median)', s.median_sats === null ? '—' : String(s.median_sats)],
    ['Battery', s.battery_start_pct === null ? '—' : `${pct(s.battery_start_pct)} → ${pct(s.battery_end_pct)}`],
    ['Lowest battery', pct(s.battery_min_pct)],
  ];
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </section>

      <section aria-label="Patrol route">
        <h3 className="mb-2 text-sm font-semibold">
          Patrol route <span className="font-normal text-muted">· {istHm(r.from)}–{endHm(r.to)} IST</span>
        </h3>
        {r.path.length > 1 ? (
          <div style={{ height: 460 }}>
            <ReportMap points={r.path} height="100%" />
          </div>
        ) : (
          <p className="text-sm text-muted">No GPS positions were recorded in this period, so the route cannot be drawn.</p>
        )}
        {r.path_hidden > 0 && <p className="mt-1 text-xs text-muted">{r.path_hidden} positions without a reliable fix are left out.</p>}
      </section>

      <ActivityBar r={r} />

      {r.missions.length > 0 && <ReportMissions missions={r.missions} />}

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-label="Hour by hour">
          <h3 className="mb-2 text-sm font-semibold">Hour by hour</h3>
          <DataTable
            caption="Hour by hour"
            dense
            rows={r.hours}
            rowKey={(h) => h.from}
            columns={[
              { key: 'h', header: 'Hour (IST)', rowHeader: true, cell: (h) => `${istHm(h.from)} – ${endHm(h.to)}` },
              { key: 'on', header: 'Online', align: 'right', cell: (h) => `${h.online_min} min` },
              { key: 'd', header: 'Distance', align: 'right', cell: (h) => fmtDistance(h.distance_m) },
              { key: 'm', header: 'Moving', align: 'right', cell: (h) => `${Math.round(h.moving_s / 60)} min` },
            ]}
          />
        </section>
        <section aria-label="Coverage notes">
          <h3 className="mb-2 text-sm font-semibold">Coverage</h3>
          <dl className="grid gap-2 text-sm">
            <Note label="Continuous coverage">
              {r.longest_online ? `${istHm(r.longest_online.from)} – ${istHm(r.longest_online.to)} IST (${fmtDuration((Date.parse(r.longest_online.to) - Date.parse(r.longest_online.from)) / 1000)} unbroken)` : '—'}
            </Note>
            <Note label="Offline gaps">
              {r.offline_gaps.length
                ? r.offline_gaps
                    .slice(0, 8)
                    .map((g) => `${istHm(g.from)}–${endHm(g.to)}`)
                    .join(', ') + (r.offline_gaps.length > 8 ? ` (+${r.offline_gaps.length - 8} more)` : '')
                : 'None — the robot reported throughout'}
            </Note>
            {r.longest_legs.length > 0 && (
              <Note label="Longest patrol legs">
                {r.longest_legs.map((l) => `${istHm(l.from)}–${istHm(l.to)} (${Math.round((Date.parse(l.to) - Date.parse(l.from)) / 60000)} min)`).join(', ')}
              </Note>
            )}
            <Note label="Distance measured by">{s.distance_source === 'odometer' ? 'Wheel odometer' : s.distance_source === 'wheel_speed' ? 'Wheel speed' : '—'}</Note>
            {r.clipped && <Note label="Data shown">Part of this period is before your organization took over the robot and is not included.</Note>}
          </dl>
        </section>
      </div>
    </div>
  );
}

function Note({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 border-b border-border pb-2 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Minute by minute: parked (navy) / patrolling (green) / no data (grey), as in the PDF. */
function ActivityBar({ r }: { r: DayReportDto }) {
  const mins = r.activity.length;
  const startMs = Date.parse(r.from);
  const step = mins > 300 ? 60 : mins > 90 ? 15 : 5;
  const colors = ['#d7dadf', '#1b2a49', '#228b54'];
  const ticks = Array.from({ length: Math.floor(mins / step) + 1 }, (_, i) => i * step);
  return (
    <section aria-label="Robot activity">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Robot activity</h3>
        <div className="flex flex-wrap gap-3 text-xs text-muted">
          {[
            [1, 'Online (parked)'],
            [2, 'Patrolling (> 0.2 m/s)'],
            [0, 'No data'],
          ].map(([k, label]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-3.5 rounded-sm" style={{ background: colors[k as number] }} aria-hidden />
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex h-7 w-full overflow-hidden rounded" role="img" aria-label={`Minute-by-minute activity ${istHm(r.from)} to ${endHm(r.to)} IST`}>
        {r.activity.map((a, i) => (
          <span key={i} className="h-full" style={{ width: `${100 / mins}%`, background: colors[a] ?? colors[0] }} />
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-muted">
        {ticks.map((m) => (
          <span key={m} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${(m / mins) * 100}%` }}>
            {istHm(startMs + m * 60_000)}
          </span>
        ))}
      </div>
    </section>
  );
}

function ReportMissions({ missions }: { missions: DayReportDto['missions'] }) {
  return (
    <section aria-label="Missions in this period">
      <h3 className="mb-2 text-sm font-semibold">
        Missions <span className="font-normal text-muted">· {missions.length} in this period</span>
      </h3>
      <DataTable
        caption="Missions in this period"
        dense
        rows={missions as Pick<ClientMissionDto, 'mission_id' | 'name' | 'started_at' | 'ended_at' | 'result' | 'distance_m'>[]}
        rowKey={(m) => m.mission_id}
        columns={[
          { key: 'name', header: 'Mission', rowHeader: true, cell: (m) => m.name ?? m.mission_id },
          { key: 'start', header: 'Start', cell: (m) => istHm(m.started_at) },
          { key: 'end', header: 'End', cell: (m) => istHm(m.ended_at) },
          { key: 'dist', header: 'Distance', align: 'right', cell: (m) => fmtDistance(m.distance_m) },
          { key: 'res', header: 'Result', cell: (m) => <MissionResultBadge result={m.result} /> },
        ]}
      />
    </section>
  );
}
