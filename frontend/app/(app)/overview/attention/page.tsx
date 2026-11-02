'use client';

import type { ActiveFaultDto, DashboardDto, EventCalendarDayDto, EventDto, Paginated } from '@arnobot/message-schema';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, CheckCheck, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CalendarLayout, dayBounds, dayTitle, istToday, MonthCalendar } from '@/components/domain/activity-calendar';
import { attentionItems, AttentionList, DashboardPage, faultTitle } from '@/components/domain/dashboard';
import { RobotRef, useRobotDirectory } from '@/components/domain/robot-ref';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Badge, Card, EmptyState, Pagination, QueryView } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtAgo, fmtWhen, humanize } from '@/lib/format';
import { useDebounced, useDocumentTitle, useNow, useUrlState } from '@/lib/hooks';
import { useProducts } from '@/lib/queries';
import { EVENT_TYPES } from '@/lib/schema';

/** The filters, kept in the URL so a filtered view can be shared or bookmarked. */
interface Filters {
  q: string;
  /** all = critical and warning. */
  sev: 'all' | 'critical' | 'warning';
  /** open = nobody has acknowledged it yet. */
  status: 'open' | 'reviewed' | 'all';
  cat: '' | 'ugv' | 'uav';
  model: string;
  type: string;
  day: string | null;
}

/** Filters as the event list and calendar take them. */
function apiFilters(f: Filters) {
  return {
    severities: f.sev === 'all' ? 'critical,warning' : f.sev,
    unacked: f.status === 'open' || undefined,
    acked: f.status === 'reviewed' || undefined,
    category: f.cat || undefined,
    product: f.model || undefined,
    type: f.type || undefined,
    q: f.q || undefined,
  };
}

/**
 * Needs attention: the problems themselves, filtered and by day. A month calendar shows how many alerts each day
 * had (red dot = critical ones); the filters (words, severity, reviewed or not, UGV / UAV, base model, problem type)
 * apply to the calendar and the lists alike. Faults still going on come first, then every matching alert with
 * Acknowledge, then warranties ending.
 */
export default function AttentionPage() {
  useDocumentTitle('Needs attention');
  const [params, setParams] = useUrlState();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day') : null;
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);
  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParams({ q: q || null, page: null });
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const f: Filters = {
    q,
    sev: (['critical', 'warning'].includes(params.get('sev') ?? '') ? params.get('sev') : 'all') as Filters['sev'],
    status: (['reviewed', 'all'].includes(params.get('status') ?? '') ? params.get('status') : 'open') as Filters['status'],
    cat: (['ugv', 'uav'].includes(params.get('cat') ?? '') ? params.get('cat') : '') as Filters['cat'],
    model: params.get('model') ?? '',
    type: params.get('type') ?? '',
    day,
  };
  const filtered = !!(f.q || f.sev !== 'all' || f.status !== 'open' || f.cat || f.model || f.type);
  const set = (patch: Record<string, string | null>) => setParams({ ...patch, page: null });

  return (
    <DashboardPage title="Needs attention" description="Faults going on now and alerts nobody has reviewed yet. Filter them, or pick a day on the calendar.">
      {(d) => (
        <div className="flex flex-col gap-5">
          <FilterBar f={f} search={search} setSearch={setSearch} set={set} filtered={filtered} clear={() => (setSearch(''), setParams({ q: null, sev: null, status: null, cat: null, model: null, type: null, page: null }))} />
          <CalendarLayout calendar={<AlertCalendar f={f} start={newestMonth(d)} onDay={(x) => set({ day: x })} />}>
            <Results d={d} f={f} page={Number(params.get('page') ?? 1) || 1} onPage={(p) => setParams({ page: p === 1 ? null : p })} />
          </CalendarLayout>
        </div>
      )}
    </DashboardPage>
  );
}

function FilterBar({
  f,
  search,
  setSearch,
  set,
  filtered,
  clear,
}: {
  f: Filters;
  search: string;
  setSearch: (v: string) => void;
  set: (patch: Record<string, string | null>) => void;
  filtered: boolean;
  clear: () => void;
}) {
  const products = useProducts();
  const models = (products.data ?? []).filter((p) => !p.deleted_at && (!f.cat || p.category === f.cat));
  return (
    // Wraps onto as many rows as it needs, so no choice is ever cut off.
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-sm [&>select]:w-auto [&>select]:min-w-[11rem] [&>select]:flex-1 sm:[&>select]:flex-none">
      <span className="relative min-w-0 flex-1 basis-full lg:basis-80">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Robot, nickname, code or message" aria-label="Search alerts" className="pl-9" />
      </span>
      <Select value={f.sev} onChange={(e) => set({ sev: e.target.value === 'all' ? null : e.target.value })} aria-label="Severity">
        <option value="all">Critical and warning</option>
        <option value="critical">Critical only</option>
        <option value="warning">Warning only</option>
      </Select>
      <Select value={f.status} onChange={(e) => set({ status: e.target.value === 'open' ? null : e.target.value })} aria-label="Reviewed or not">
        <option value="open">Not reviewed yet</option>
        <option value="reviewed">Reviewed</option>
        <option value="all">Reviewed or not</option>
      </Select>
      <Select value={f.cat} onChange={(e) => set({ cat: e.target.value || null, model: null })} aria-label="Category">
        <option value="">UGV and UAV</option>
        <option value="ugv">UGV only</option>
        <option value="uav">UAV only</option>
      </Select>
      <Select value={f.model} onChange={(e) => set({ model: e.target.value || null })} aria-label="Base model">
        <option value="">All base models</option>
        {models.map((p) => (
          <option key={p.id} value={p.code}>
            {p.name}
          </option>
        ))}
      </Select>
      <Select value={f.type} onChange={(e) => set({ type: e.target.value || null })} aria-label="Problem type">
        <option value="">All problem types</option>
        {EVENT_TYPES.map((t) => (
          <option key={t} value={t}>
            {humanize(t)}
          </option>
        ))}
      </Select>
      {filtered && (
        <Button variant="ghost" icon={<X className="size-4" aria-hidden />} onClick={clear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/** The month (YYYY-MM, IST) of the newest alert or fault, so the calendar opens where there is something to see. */
function newestMonth(d: DashboardDto): string {
  const times = [...d.recent_events.map((e) => e.ts), ...d.critical_events.map((e) => e.ts), ...d.active_faults.map((x) => x.since)].map((t) => Date.parse(t)).filter(Number.isFinite);
  if (!times.length) return istToday().slice(0, 7);
  return new Date(Math.max(...times)).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
}

const alertsLabel = (n: number) => `${n} alert${n === 1 ? '' : 's'}`;

/** The month, each day shaded by its matching alerts, a red dot when some were critical. */
function AlertCalendar({ f, start, onDay }: { f: Filters; start: string; onDay: (d: string | null) => void }) {
  const [month, setMonth] = useState(f.day ? f.day.slice(0, 7) : start);
  const filters = apiFilters(f);
  const q = useQuery({
    queryKey: ['events', 'calendar', month, filters],
    queryFn: () => api.get<EventCalendarDayDto[]>('/events/calendar', { month, ...filters }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const byDay = new Map((q.data ?? []).map((x) => [x.date, x]));
  const picked = f.day ? byDay.get(f.day) : undefined;
  return (
    <MonthCalendar
      month={month}
      onMonth={setMonth}
      loading={q.isFetching && !q.data}
      value={(c) => {
        const x = byDay.get(c);
        return { n: x?.total ?? 0, alert: x?.critical ?? 0 };
      }}
      label={alertsLabel}
      alertLabel="critical"
      day={f.day}
      onDay={onDay}
    >
      {f.day ? (
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-sm font-semibold">{dayTitle(f.day)}</p>
            <button type="button" onClick={() => onDay(null)} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent-text hover:underline">
              <X className="size-3.5" aria-hidden /> All days
            </button>
          </div>
          <ul className="grid gap-1 text-sm">
            <li className="font-semibold">{alertsLabel(picked?.total ?? 0)}</li>
            <li className="flex items-center gap-2">
              <span className="size-2.5 rounded-sm bg-[var(--chart-critical)]" aria-hidden /> Critical <span className="ml-auto font-semibold tabular-nums">{picked?.critical ?? 0}</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="size-2.5 rounded-sm bg-[var(--chart-warning)]" aria-hidden /> Warning <span className="ml-auto font-semibold tabular-nums">{picked?.warning ?? 0}</span>
            </li>
            <li className="flex items-center gap-2 text-muted">
              Not reviewed <span className="ml-auto font-semibold text-fg tabular-nums">{picked?.unacked ?? 0}</span>
            </li>
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted">Pick a day to see only its alerts. Counts follow the filters above.</p>
      )}
    </MonthCalendar>
  );
}

const LIMIT = 25;

function Results({ d, f, page, onPage }: { d: DashboardDto; f: Filters; page: number; onPage: (p: number) => void }) {
  const dir = useRobotDirectory();
  const products = useProducts();
  const modelName = products.data?.find((p) => p.code === f.model)?.name;
  // Faults going on now, through the same filters (they are open by nature, so hidden when only reviewed alerts are asked for).
  const words = f.q.toLowerCase();
  const faults = d.active_faults.filter((x: ActiveFaultDto) => {
    const r = dir.get(x.robot_id);
    if (f.status === 'reviewed') return false;
    if (f.sev !== 'all' && x.severity !== f.sev) return false;
    if (f.cat && r && r.category !== f.cat) return false;
    if (f.model && r && r.product_name !== modelName) return false;
    if (f.day) {
      const t = Date.parse(x.since);
      const b = dayBounds(f.day);
      if (t < Date.parse(b.from) || t >= Date.parse(b.to)) return false;
    }
    if (words && ![x.robot_id, r?.nickname, x.code, x.message].some((v) => v?.toLowerCase().includes(words))) return false;
    return true;
  });
  const critical = faults.filter((x) => x.severity === 'critical').length;
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Count label="Critical faults going on now" value={critical} tone="fault" icon={<AlertOctagon className="size-5" />} />
        <Count label="Warnings going on now" value={faults.length - critical} tone="warn" icon={<AlertTriangle className="size-5" />} />
      </dl>

      {f.status !== 'reviewed' && (
        <section aria-labelledby="active-h">
          <h2 id="active-h" className="mb-3 text-xl font-semibold">
            Going on now{f.day ? ` · started ${dayTitle(f.day)}` : ''}
          </h2>
          {faults.length ? (
            <AttentionList items={attentionItems({ ...d, active_faults: faults, critical_event_groups: [], warranty_expiring: [] })} />
          ) : (
            <p className="rounded-xl border border-border bg-surface p-4 text-base text-muted">No fault going on matches these filters.</p>
          )}
        </section>
      )}

      <AlertList f={f} page={page} onPage={onPage} />

      {!f.day && f.status !== 'reviewed' && d.warranty_expiring.length > 0 && (
        <section aria-labelledby="warranty-h">
          <h2 id="warranty-h" className="mb-3 text-xl font-semibold">
            Warranties ending in 30 days
          </h2>
          <AttentionList items={attentionItems({ ...d, active_faults: [], critical_event_groups: [] })} />
        </section>
      )}
    </div>
  );
}

function Count({ label, value, tone, icon }: { label: string; value: number; tone: 'fault' | 'warn'; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm">
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', value ? (tone === 'fault' ? 'bg-fault-bg text-fault' : 'bg-warn-bg text-warn') : 'bg-surface-2 text-muted')} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-sm text-muted">{label}</dt>
        <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      </div>
    </div>
  );
}

/** Every alert matching the filters (and the day), newest first, with Acknowledge for each and for the page. */
function AlertList({ f, page, onPage }: { f: Filters; page: number; onPage: (p: number) => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow(30_000);
  const filters = apiFilters(f);
  const list = useQuery({
    queryKey: ['events', 'attention', filters, f.day, page],
    queryFn: () => api.get<Paginated<EventDto>>('/events', { ...filters, ...(f.day ? dayBounds(f.day) : {}), page, limit: LIMIT }),
    placeholderData: keepPreviousData,
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['events'] });
  };
  const ackOne = useMutation({
    mutationFn: (id: string) => api.post<EventDto>(`/events/${id}/ack`),
    onSuccess: () => {
      toast.success('Alert marked as reviewed');
      done();
    },
    onError: toast.error,
  });
  const open = (list.data?.items ?? []).filter((e) => !e.acknowledged_at);
  const ackAll = useMutation({
    mutationFn: () => api.post<{ acknowledged: number }>('/events/ack', { ids: open.map((e) => e.id) }),
    onSuccess: (r) => {
      toast.success(`${r.acknowledged} alert${r.acknowledged === 1 ? '' : 's'} marked as reviewed`);
      done();
    },
    onError: toast.error,
  });
  const canAck = can('event.ack');
  const what = f.status === 'open' ? 'Alerts not reviewed yet' : f.status === 'reviewed' ? 'Reviewed alerts' : 'Alerts';
  return (
    <Card
      title={`${what}${f.day ? ` · ${dayTitle(f.day)}` : ''}${list.data ? ` (${list.data.total.toLocaleString('en-IN')})` : ''}`}
      actions={
        canAck && open.length > 1 ? (
          <Button size="sm" icon={<CheckCheck className="size-4" aria-hidden />} onClick={() => ackAll.mutate()} loading={ackAll.isPending}>
            Mark all on this page reviewed
          </Button>
        ) : undefined
      }
      bodyClassName="p-0"
    >
      <QueryView query={list} rows={5}>
        {(data) =>
          data.items.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Nothing matches" description={f.day ? 'No alert on this day with these filters. Pick another day, or All days.' : 'Change the filters to see more.'} />
            </div>
          ) : (
            <>
              <ul className={cn('divide-y divide-border transition-opacity', list.isPlaceholderData && 'opacity-60')}>
                {data.items.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
                    <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', e.severity === 'critical' ? 'bg-fault-bg text-fault' : 'bg-warn-bg text-warn')} aria-hidden>
                      {e.severity === 'critical' ? <AlertOctagon className="size-5" /> : <AlertTriangle className="size-5" />}
                    </span>
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-base font-semibold">{faultTitle(e.code, humanize(e.type))}</span>
                        <RobotRef id={e.robot_id} href={`/robots/${e.robot_id}?tab=events`} detail={false} className="text-sm" />
                      </p>
                      <p className="text-sm text-muted">{e.message}</p>
                    </div>
                    <span className="text-right text-sm">
                      <span className="block font-medium">{fmtAgo(e.ts, now)}</span>
                      <span className="block text-muted">{fmtWhen(e.ts, now)}</span>
                    </span>
                    {e.acknowledged_at ? (
                      <Badge tone="ok">Reviewed</Badge>
                    ) : (
                      canAck && (
                        <Button size="sm" onClick={() => ackOne.mutate(e.id)} loading={ackOne.isPending && ackOne.variables === e.id}>
                          Mark reviewed
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
              <div className="px-5 pb-4">
                <Pagination page={data.page} limit={data.limit} total={data.total} onPage={onPage} />
              </div>
            </>
          )
        }
      </QueryView>
    </Card>
  );
}
