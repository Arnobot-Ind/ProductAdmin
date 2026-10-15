'use client';

import { CLIENT_FEATURES, type FleetReportDto, type LiveStateDto } from '@arnobot/message-schema';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { RobotStatusBadge } from '@/components/common/status';
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useFeature, useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtDuration, fmtRelative } from '@/lib/format';
import { useDocumentTitle, useNow } from '@/lib/hooks';

// Leaflet is client-only.
const ReportMap = dynamic(() => import('@/components/client/report-map').then((m) => m.ReportMap), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading map…</div>,
});

const IST = 'Asia/Kolkata';
/** IST calendar day `daysAgo` days back, YYYY-MM-DD. */
const istDay = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString('en-CA', { timeZone: IST });
const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-GB', { timeZone: IST, ...opts });

const PERIODS = [
  { id: 'today', label: 'Today', range: () => ({ from: istDay(), to: istDay() }) },
  { id: '7d', label: '7 days', range: () => ({ from: istDay(6), to: istDay() }) },
  { id: '30d', label: '30 days', range: () => ({ from: istDay(29), to: istDay() }) },
  { id: 'month', label: 'This month', range: () => ({ from: `${istDay().slice(0, 8)}01`, to: istDay() }) },
] as const;
type PeriodId = (typeof PERIODS)[number]['id'];

/**
 * The client dashboard: the organization's robots over a period — distance at a glance, plus missions and results
 * (portal.missions.view) and where the robots are now (portal.robots.location).
 */
export default function PortalDashboardPage() {
  useDocumentTitle('Dashboard');
  const me = useMe();
  const [period, setPeriod] = useState<PeriodId>('30d');
  const range = PERIODS.find((p) => p.id === period)!.range();
  const q = useQuery({
    queryKey: ['portal', 'fleet', range.from, range.to],
    queryFn: () => api.get<FleetReportDto>('/reports/fleet', range),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  return (
    <>
      <PageHeader eyebrow={me.organization.name} title="Dashboard" description="Your robots' missions and distance driven. Times are IST." />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Period" className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={period === p.id}
              onClick={() => setPeriod(p.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                period === p.id ? 'border-accent bg-accent-soft font-semibold text-accent-text' : 'border-border text-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading ? (
        <LoadingBlock rows={6} label="Loading dashboard" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <Dashboard data={q.data} />
      ) : null}
    </>
  );
}

function Dashboard({ data }: { data: FleetReportDto }) {
  const has = useFeature();
  const missions = has(CLIENT_FEATURES.missionsView);
  const t = data.totals;
  if (!t.robots) {
    return <EmptyState title="No robots yet" description="No robot is assigned to your organization yet. Contact Arnobot to have your robots added." />;
  }
  const unsuccessful = t.aborted + t.failed;
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="Robots online" value={`${t.online} / ${t.robots}`} />
        {missions && (
          <>
            <Tile label="Missions" value={String(t.total)} note={t.in_progress ? `${t.in_progress} in progress` : undefined} />
            <Tile label="Completed" value={String(t.completed)} note={t.total ? `${Math.round((t.completed / t.total) * 100)} % of missions` : undefined} />
            <Tile label="Aborted or failed" value={String(unsuccessful)} note={unsuccessful ? `${t.aborted} aborted · ${t.failed} failed` : undefined} />
          </>
        )}
        <Tile label="Distance driven" value={fmtDistance(t.driven_m)} />
        <Tile label="Time on the move" value={fmtDuration(t.moving_s)} />
      </section>

      {has(CLIENT_FEATURES.robotsLocation) && <FleetMap robots={data.robots} />}

      {data.daily.length > 1 && (
        <div className={cn('grid gap-5', missions && 'lg:grid-cols-2')}>
          {missions && (
            <Card title="Missions per day">
              <MissionsChart daily={data.daily} />
            </Card>
          )}
          <Card title="Distance driven per day (km)">
            <DistanceChart daily={data.daily} />
          </Card>
        </div>
      )}

      <Card title="Robots" bodyClassName="p-0">
        <RobotsTable robots={data.robots} missions={missions} />
      </Card>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

// ── charts: plain HTML columns, one axis each, hover/focus tooltip, table view ─────────────
type Day = FleetReportDto['daily'][number];

/** Round the largest value up to a clean axis top and give 4 even ticks (0 included). */
function axis(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return Array.from({ length: 5 }, (_, i) => +(i * step).toFixed(6));
}

const fmtTick = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : String(+v.toFixed(1)));

/** Shared frame: y ticks + hairline grid, columns, x labels on a sparse cadence, a hover/focus tooltip. */
function ColumnChart({
  daily,
  ticks,
  column,
  tooltip,
  label,
}: {
  daily: Day[];
  ticks: number[];
  column: (d: Day, scale: (v: number) => number) => ReactNode;
  tooltip: (d: Day) => ReactNode;
  label: (d: Day) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const top = ticks[ticks.length - 1];
  const scale = (v: number) => (v / top) * 100;
  const every = Math.max(1, Math.ceil(daily.length / 8));
  const H = 168;
  return (
    <div className="relative">
      <div className="flex" style={{ height: H }}>
        <div className="relative w-9 shrink-0 text-right text-[11px] tabular-nums text-muted" aria-hidden>
          {ticks.map((v) => (
            <span key={v} className="absolute right-2" style={{ bottom: `${scale(v)}%`, transform: "translateY(50%)" }}>
              {fmtTick(v)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-border" style={{ bottom: `${scale(v)}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end">
            {daily.map((d, i) => (
              <div
                key={d.date}
                tabIndex={0}
                role="img"
                aria-label={label(d)}
                className="flex h-full flex-1 cursor-default items-end justify-center outline-none focus-visible:bg-surface-2"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <div className={cn('flex h-full w-full max-w-6 flex-col justify-end px-px transition-opacity', hover !== null && hover !== i && 'opacity-60')}>{column(d, scale)}</div>
              </div>
            ))}
          </div>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-max max-w-52 -translate-x-1/2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-md"
              style={{ left: `${Math.min(88, Math.max(12, ((hover + 0.5) / daily.length) * 100))}%` }}
            >
              <p className="font-semibold">{dayLabel(daily[hover].date, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
              {tooltip(daily[hover])}
            </div>
          )}
        </div>
      </div>
      <div className="ml-9 flex text-[11px] text-muted" aria-hidden>
        {daily.map((d, i) => (
          <span key={d.date} className="flex-1 truncate pt-1 text-center">
            {i % every === 0 ? dayLabel(d.date, { day: 'numeric', month: 'short' }) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Mission results are states, so they wear the reserved status tokens — always with a legend label. */
const RESULTS = [
  { key: 'completed', label: 'Completed', color: 'var(--ok)' },
  { key: 'aborted', label: 'Aborted', color: 'var(--warn)' },
  { key: 'failed', label: 'Failed', color: 'var(--fault)' },
] as const;

function MissionsChart({ daily }: { daily: Day[] }) {
  const [table, setTable] = useState(false);
  const ticks = axis(Math.max(...daily.map((d) => d.completed + d.aborted + d.failed)));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {RESULTS.map((r) => (
          <span key={r.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: r.color }} aria-hidden />
            {r.label}
          </span>
        ))}
        <TableToggle on={table} onToggle={() => setTable((x) => !x)} />
      </div>
      {table ? (
        <DayTable daily={daily} cols={[...RESULTS.map((r) => ({ label: r.label, value: (d: Day) => String(d[r.key]) })), { label: 'Total', value: (d: Day) => String(d.missions) }]} />
      ) : (
        <ColumnChart
          daily={daily}
          ticks={ticks}
          label={(d) => `${dayLabel(d.date, { day: 'numeric', month: 'short' })}: ${d.completed} completed, ${d.aborted} aborted, ${d.failed} failed`}
          tooltip={(d) => (
            <ul className="mt-0.5">
              {RESULTS.map((r) => (
                <li key={r.key} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm" style={{ background: r.color }} aria-hidden />
                  {r.label} <span className="ml-auto pl-3 font-semibold tabular-nums">{d[r.key]}</span>
                </li>
              ))}
            </ul>
          )}
          column={(d, scale) => {
            // Stacked from the baseline: completed at the bottom; 2px surface gap between segments; only the top one is rounded.
            const parts = RESULTS.filter((r) => d[r.key] > 0);
            return parts
              .slice()
              .reverse()
              .map((r, i) => (
                <div
                  key={r.key}
                  className={cn('w-full', i === 0 && 'rounded-t-[4px]', i > 0 && 'border-t-2 border-surface')}
                  style={{ height: `${scale(d[r.key])}%`, background: r.color, boxSizing: 'border-box' }}
                />
              ));
          }}
        />
      )}
    </>
  );
}

function DistanceChart({ daily }: { daily: Day[] }) {
  const [table, setTable] = useState(false);
  const km = (d: Day) => d.driven_m / 1000;
  const ticks = axis(Math.max(...daily.map(km)));
  return (
    <>
      <div className="mb-3 flex items-center text-xs text-muted">
        <span>Odometer distance, all robots</span>
        <TableToggle on={table} onToggle={() => setTable((x) => !x)} />
      </div>
      {table ? (
        <DayTable daily={daily} cols={[{ label: 'Distance driven', value: (d) => fmtDistance(d.driven_m) }]} />
      ) : (
        <ColumnChart
          daily={daily}
          ticks={ticks}
          label={(d) => `${dayLabel(d.date, { day: 'numeric', month: 'short' })}: ${fmtDistance(d.driven_m)} driven`}
          tooltip={(d) => <p className="mt-0.5">{fmtDistance(d.driven_m)} driven</p>}
          column={(d, scale) => (d.driven_m > 0 ? <div className="w-full rounded-t-[4px]" style={{ height: `${scale(km(d))}%`, background: 'var(--accent)' }} /> : null)}
        />
      )}
    </>
  );
}

function TableToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={on} className="ml-auto rounded px-1.5 py-0.5 font-medium text-accent-text hover:underline">
      {on ? 'Show chart' : 'Show table'}
    </button>
  );
}

function DayTable({ daily, cols }: { daily: Day[]; cols: { label: string; value: (d: Day) => string }[] }) {
  return (
    <div className="max-h-64 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
          <tr>
            <th className="py-1.5 font-medium">Date</th>
            {cols.map((c) => (
              <th key={c.label} className="py-1.5 text-right font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...daily].reverse().map((d) => (
            <tr key={d.date} className="border-t border-border">
              <td className="py-1.5">{dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
              {cols.map((c) => (
                <td key={c.label} className="py-1.5 text-right tabular-nums">
                  {c.value(d)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── where the robots are now ────────────────────────────────────────────────
/** Each robot's last reported position (its live state; the API hides positions without portal.robots.location). */
function FleetMap({ robots }: { robots: FleetReportDto['robots'] }) {
  const lives = useQueries({
    queries: robots.map((r) => ({
      queryKey: ['robot', r.robot_id, 'live'],
      queryFn: () => api.get<LiveStateDto>(`/robots/${r.robot_id}/live`),
      refetchInterval: 30_000,
      retry: false,
    })),
  });
  const json = JSON.stringify(
    robots.flatMap((r, i) => {
      const p = lives[i]?.data?.position;
      return p ? [{ lat: p.lat, lon: p.lon, label: r.robot_id.toUpperCase() }] : [];
    }),
  );
  // Same array while no robot moved, so the map only re-fits when a position changes.
  const markers = useMemo(() => JSON.parse(json) as { lat: number; lon: number; label: string }[], [json]);
  const loading = lives.some((l) => l.isLoading);
  return (
    <Card title="Where your robots are">
      {markers.length ? (
        <div className="h-80">
          <ReportMap markers={markers} height="100%" />
        </div>
      ) : loading ? (
        <LoadingBlock rows={3} label="Loading positions" />
      ) : (
        <EmptyState title="No positions yet" description="None of your robots has reported a GPS position." />
      )}
    </Card>
  );
}

// ── robots table ──────────────────────────────────────────────────────────
type Robot = FleetReportDto['robots'][number];
function RobotsTable({ robots, missions }: { robots: FleetReportDto['robots']; missions: boolean }) {
  const now = useNow(10_000);
  const rows = [...robots].sort((a, b) => a.robot_id.localeCompare(b.robot_id));
  const num = (n: number) => <span className="tabular-nums">{n}</span>;
  return (
    <DataTable
      caption="Robots"
      rows={rows}
      rowKey={(r) => r.robot_id}
      empty={<EmptyState title="No robots" />}
      columns={[
        {
          key: 'robot',
          header: 'Robot',
          rowHeader: true,
          cell: (r) => (
            <Link href={`/robots/${r.robot_id}`} className="font-mono font-semibold text-accent-text hover:underline">
              {r.robot_id.toUpperCase()}
            </Link>
          ),
        },
        { key: 'status', header: 'Status', cell: (r) => <RobotStatusBadge lastSeenAt={r.last_seen_at} /> },
        { key: 'battery', header: 'Battery', align: 'right', cell: (r) => (r.battery_pct === null ? <span className="text-muted">—</span> : `${Math.round(r.battery_pct)} %`) },
        ...(missions
          ? [
              { key: 'missions', header: 'Missions', align: 'right' as const, cell: (r: Robot) => num(r.missions.total) },
              { key: 'completed', header: 'Completed', align: 'right' as const, cell: (r: Robot) => num(r.missions.completed) },
              { key: 'aborted', header: 'Aborted', align: 'right' as const, cell: (r: Robot) => num(r.missions.aborted) },
              { key: 'failed', header: 'Failed', align: 'right' as const, cell: (r: Robot) => num(r.missions.failed) },
            ]
          : []),
        { key: 'driven', header: 'Distance driven', align: 'right', cell: (r) => fmtDistance(r.driven_m) },
        { key: 'seen', header: 'Last seen', cell: (r) => (r.last_seen_at ? fmtRelative(r.last_seen_at, now) : 'Never') },
      ]}
    />
  );
}
