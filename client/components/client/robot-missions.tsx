'use client';

import { CLIENT_FEATURES, type ClientMissionDto, type ClientMissionsDto, type MissionState, type MissionStatsDto, type RobotDetailDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, FileDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, Pagination } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useFeature } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDistance, fmtDuration } from '@/lib/format';
import { downloadMissionReport } from '@/lib/robot-reports';

// ── IST helpers (shared by the client robot page) ───────────────────────────
const IST = 'Asia/Kolkata';
/** Today's (or `daysAgo` days back) IST calendar day, YYYY-MM-DD. */
export const istDay = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString('en-CA', { timeZone: IST });
export const istHm = (iso: string | number | null) =>
  iso === null ? '—' : new Date(iso).toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });
const istDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const RESULT: Record<MissionState, { label: string; tone: 'ok' | 'fault' | 'accent' }> = {
  completed: { label: 'Completed', tone: 'ok' },
  aborted: { label: 'Aborted', tone: 'fault' },
  failed: { label: 'Failed', tone: 'fault' },
  in_progress: { label: 'In progress', tone: 'accent' },
};
export function MissionResultBadge({ result }: { result: MissionState }) {
  const r = RESULT[result] ?? { label: result, tone: 'accent' as const };
  return <Badge tone={r.tone}>{r.label}</Badge>;
}

// ── data ────────────────────────────────────────────────────────────────────
interface MissionQuery {
  from?: string;
  to?: string;
  result?: MissionState;
  page?: number;
  limit?: number;
}
function useMissions(robotId: string, q: MissionQuery) {
  return useQuery({
    queryKey: ['robot', robotId, 'client-missions', q],
    queryFn: () => api.get<ClientMissionsDto>(`/robots/${robotId}/reports/missions`, { ...q }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

const successRate = (s: MissionStatsDto) => {
  const done = s.completed + s.aborted + s.failed;
  return done ? `${Math.round((s.completed / done) * 100)} %` : '—';
};

/** Compact KPI tiles: totals over whatever the stats cover. */
export function MissionStatsTiles({ stats }: { stats: MissionStatsDto }) {
  const tiles: { label: string; value: string; tone?: 'ok' | 'fault' }[] = [
    { label: 'Total missions', value: stats.total.toLocaleString() },
    { label: 'Completed', value: stats.completed.toLocaleString(), tone: 'ok' },
    { label: 'Aborted', value: stats.aborted.toLocaleString(), tone: stats.aborted ? 'fault' : undefined },
    { label: 'Failed', value: stats.failed.toLocaleString(), tone: stats.failed ? 'fault' : undefined },
    { label: 'Mission distance', value: fmtDistance(stats.distance_m) },
    { label: 'Mission time', value: fmtDuration(stats.duration_s) },
    { label: 'Success rate', value: successRate(stats) },
  ];
  return (
    <section aria-label="Mission statistics" className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t.label}</p>
          <p className={cn('mt-1 text-lg font-semibold tabular-nums', t.tone === 'ok' && 'text-ok', t.tone === 'fault' && 'text-fault')}>{t.value}</p>
        </div>
      ))}
    </section>
  );
}

/** Downloads one mission's Mission Report PDF (the robot record is fetched for the report header). */
function MissionPdfButton({ robotId, mission }: { robotId: string; mission: ClientMissionDto }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await downloadMissionReport(await api.get<RobotDetailDto>(`/robots/${robotId}`), mission.mission_id);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="ghost" icon={<FileDown className="size-4" aria-hidden />} loading={busy} onClick={() => void download()} aria-label={`Download the report of ${mission.name ?? mission.mission_id}`}>
      PDF
    </Button>
  );
}

type MissionColumn = { key: string; header: string; rowHeader?: boolean; align?: 'right'; cell: (m: ClientMissionDto) => ReactNode };
function missionColumns(robotId: string, withReason: boolean, withPdf: boolean): MissionColumn[] {
  const cols: MissionColumn[] = [
    { key: 'name', header: 'Mission', rowHeader: true, cell: (m: ClientMissionDto) => <span className="font-medium">{m.name ?? m.mission_id}</span> },
    { key: 'date', header: 'Date', cell: (m: ClientMissionDto) => <span className="whitespace-nowrap">{istDate(m.started_at)}</span> },
    { key: 'start', header: 'Start', cell: (m: ClientMissionDto) => istHm(m.started_at) },
    { key: 'end', header: 'End', cell: (m: ClientMissionDto) => istHm(m.ended_at) },
    { key: 'dur', header: 'Duration', align: 'right', cell: (m: ClientMissionDto) => fmtDuration(m.duration_s) },
    { key: 'dist', header: 'Distance', align: 'right', cell: (m: ClientMissionDto) => fmtDistance(m.distance_m) },
    { key: 'res', header: 'Result', cell: (m: ClientMissionDto) => <MissionResultBadge result={m.result} /> },
  ];
  if (withPdf) cols.push({ key: 'pdf', header: 'Report', align: 'right', cell: (m: ClientMissionDto) => <MissionPdfButton robotId={robotId} mission={m} /> });
  if (withReason) cols.splice(withPdf ? cols.length - 1 : cols.length, 0, { key: 'reason', header: 'End reason', cell: (m: ClientMissionDto) => (m.end_reason ? <span>{m.end_reason}</span> : <span className="text-muted">—</span>) });
  return cols;
}

// ── Overview tab: all-time stats + last 5 missions ─────────────────────────
export function RobotMissionsOverview({ robotId, onAllMissions }: { robotId: string; onAllMissions: () => void }) {
  const canDownload = useFeature()(CLIENT_FEATURES.reportsDownload);
  const q = useMissions(robotId, { page: 1, limit: 5 });
  if (q.isLoading) return <LoadingBlock rows={4} label="Loading missions" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data!;
  return (
    <div className="flex flex-col gap-5">
      <MissionStatsTiles stats={d.stats} />
      <Card
        title="Last 5 missions"
        bodyClassName="p-0"
        actions={
          <button type="button" onClick={onAllMissions} className="inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline">
            All missions <ArrowRight className="size-3.5" aria-hidden />
          </button>
        }
      >
        {d.items.length ? (
          <DataTable caption="Last 5 missions" dense rows={d.items} rowKey={(m) => m.mission_id} columns={missionColumns(robotId, false, canDownload)} />
        ) : (
          <div className="p-4">
            <EmptyState title="No missions yet" description="Missions appear here once the robot has run one." />
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Missions tab ────────────────────────────────────────────────────────────
const PERIODS = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom…' },
] as const;
type PeriodId = (typeof PERIODS)[number]['id'];
const RESULT_FILTERS: { id: MissionState | 'all'; label: string; count: (s: MissionStatsDto) => number }[] = [
  { id: 'all', label: 'All', count: (s) => s.total },
  { id: 'completed', label: 'Completed', count: (s) => s.completed },
  { id: 'aborted', label: 'Aborted', count: (s) => s.aborted },
  { id: 'failed', label: 'Failed', count: (s) => s.failed },
  { id: 'in_progress', label: 'In progress', count: (s) => s.in_progress },
];
const LIMIT = 25;

export function RobotMissionsTab({ robotId }: { robotId: string }) {
  const canDownload = useFeature()(CLIENT_FEATURES.reportsDownload);
  const [period, setPeriod] = useState<PeriodId>('all');
  const [from, setFrom] = useState(istDay(6));
  const [to, setTo] = useState(istDay());
  const [result, setResult] = useState<MissionState | 'all'>('all');
  const [page, setPage] = useState(1);
  const range =
    period === 'all' ? {} : period === 'today' ? { from: istDay(), to: istDay() } : period === '7d' ? { from: istDay(6), to: istDay() } : period === '30d' ? { from: istDay(29), to: istDay() } : { from, to };
  // Stats cover the period (all results) so the chips keep their counts; the table follows the chip.
  const stats = useMissions(robotId, { ...range, page: 1, limit: 1 });
  const list = useMissions(robotId, { ...range, result: result === 'all' ? undefined : result, page, limit: LIMIT });
  const reset = () => setPage(1);

  return (
    <div className="flex flex-col gap-5">
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
        <Field label="Period">
          <Select
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value as PeriodId);
              reset();
            }}
          >
            {PERIODS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        {period === 'custom' && (
          <>
            <Field label="From">
              <Input
                type="date"
                value={from}
                max={to}
                onChange={(e) => {
                  setFrom(e.target.value);
                  reset();
                }}
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={to}
                min={from}
                max={istDay()}
                onChange={(e) => {
                  setTo(e.target.value);
                  reset();
                }}
              />
            </Field>
          </>
        )}
      </form>

      {stats.data ? <MissionStatsTiles stats={stats.data.stats} /> : stats.isLoading ? <LoadingBlock rows={2} label="Loading statistics" /> : null}

      <div role="group" aria-label="Filter by result" className="flex flex-wrap gap-2">
        {RESULT_FILTERS.map((f) => {
          const active = result === f.id;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setResult(f.id);
                reset();
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
                active ? 'border-accent bg-accent-soft text-accent-text' : 'border-border text-muted hover:bg-surface-2',
              )}
            >
              {f.label}
              {stats.data && <span className="tabular-nums text-xs opacity-80">{f.count(stats.data.stats)}</span>}
            </button>
          );
        })}
      </div>

      {list.isLoading ? (
        <LoadingBlock rows={6} label="Loading missions" />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data?.items.length ? (
        <EmptyState title="No missions" description="No missions match this period and result." />
      ) : (
        <div>
          <DataTable caption="Missions" rows={list.data.items} rowKey={(m) => m.mission_id} columns={missionColumns(robotId, true, canDownload)} />
          <Pagination page={page} limit={LIMIT} total={list.data.total} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
