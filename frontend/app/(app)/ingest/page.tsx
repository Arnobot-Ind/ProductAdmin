'use client';

import { RobotRef } from '@/components/domain/robot-ref';

import type { IngestCalendarDayDto, IngestLogItemDto, IngestRejectionDto, IngestSummaryDto, Paginated } from '@arnobot/message-schema';
import { CheckCircle2, ShieldAlert, X } from 'lucide-react';
import { CalendarLayout, dayBounds, dayTitle, istToday, MonthCalendar } from '@/components/domain/activity-calendar';
import { Band } from '@/components/ui/band';
import { fmtAgo, fmtWhen, humanize } from '@/lib/format';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { IngestClientsPanel } from '@/components/domain/ingest-clients';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge, EmptyState, ErrorState, InlineAlert, LoadingBlock, Mono, PageHeader, Pagination, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';
import { cn } from '@/lib/cn';

const LIMIT = 50;
/** A robot filter is sent once it is a whole Robot ID (e.g. saibya01), not while it is half typed. */
const robotFilter = (v: string) => (/^[a-z][a-z0-9_]*[0-9]+$/.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined);

export default function IngestPage() {
  useDocumentTitle('Ingest');
  const can = useCan();
  const [params, setParams] = useUrlState();
  const summary = useQuery({ queryKey: ['ingest', 'summary'], queryFn: () => api.get<IngestSummaryDto>('/ingest/summary'), enabled: can('ingest.read'), refetchInterval: 60_000 });
  const tabs = [
    ...(can('ingest.read')
      ? [
          { id: 'messages', label: `Accepted${summary.data ? ` · ${summary.data.accepted_24h.toLocaleString('en-IN')} today` : ''}` },
          { id: 'rejections', label: `Rejected${summary.data ? ` · ${summary.data.rejected_24h.toLocaleString('en-IN')} today` : ''}` },
        ]
      : []),
    ...(can('ingest.manage') ? [{ id: 'clients', label: 'Robot & GCS keys' }] : []),
  ];
  const requested = params.get('tab') ?? tabs[0]?.id;
  const tab = tabs.some((t) => t.id === requested) ? requested! : tabs[0]?.id;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day') : null;
  const setDay = (d: string | null) => setParams({ day: d, page: null });

  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Ingest"
        description="What robots and the GCS sent: accepted messages are stored exactly once (by msg_id); rejected ones are kept with the reason, for diagnosis."
      />
      {!tab ? (
        <InlineAlert tone="fault">You don&apos;t have permission to view the ingest log.</InlineAlert>
      ) : (
        <>
          {summary.data && <Summary s={summary.data} onOpen={(t) => setParams({ tab: t, page: null })} />}
          <Tabs label="Ingest sections" items={tabs} value={tab} onChange={(id) => setParams({ tab: id, page: null })} />
          <TabPanel id={tab}>
            {tab === 'clients' ? (
              <IngestClientsPanel />
            ) : (
              <CalendarLayout calendar={<IngestCalendar day={day} onDay={setDay} focus={tab === 'rejections' ? 'rejected' : 'accepted'} />}>
                {day && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent/40 bg-accent-soft px-4 py-2.5">
                    <p className="text-base font-semibold text-accent-text">{dayTitle(day)}</p>
                    <button type="button" onClick={() => setDay(null)} className="inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline">
                      <X className="size-4" aria-hidden /> All days
                    </button>
                  </div>
                )}
                {tab === 'messages' && <MessagesTab day={day} />}
                {tab === 'rejections' && <RejectionsTab day={day} errors={summary.data?.rejected_by_error_7d ?? []} />}
              </CalendarLayout>
            )}
          </TabPanel>
        </>
      )}
    </>
  );
}

/** Accepted vs rejected at a glance: today's counts, when each last happened, what was accepted and why things were rejected. */
function Summary({ s, onOpen }: { s: IngestSummaryDto; onOpen: (tab: 'messages' | 'rejections') => void }) {
  const total = s.accepted_24h + s.rejected_24h;
  const rate = total ? Math.round((s.accepted_24h / total) * 1000) / 10 : null;
  return (
    <Band label="Ingest summary" className="mb-6">
      <div className="grid gap-6 p-6 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.4fr]">
        <button type="button" onClick={() => onOpen('messages')} className="flex items-start gap-4 rounded-xl text-left hover:opacity-80">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-ok-bg text-ok" aria-hidden>
            <CheckCircle2 className="size-6" />
          </span>
          <span>
            <span className="block text-base text-muted">Accepted, last 24 h</span>
            <span className="block text-4xl font-semibold tabular-nums">{s.accepted_24h.toLocaleString('en-IN')}</span>
            <span className="block text-sm text-muted">Last {s.last_accepted_at ? `${fmtAgo(s.last_accepted_at).toLowerCase()} · ${fmtWhen(s.last_accepted_at)}` : 'never'}</span>
          </span>
        </button>
        <button type="button" onClick={() => onOpen('rejections')} className="flex items-start gap-4 rounded-xl text-left hover:opacity-80">
          <span className={cn('flex size-12 shrink-0 items-center justify-center rounded-xl', s.rejected_24h ? 'bg-fault-bg text-fault' : 'bg-surface-2 text-muted')} aria-hidden>
            <ShieldAlert className="size-6" />
          </span>
          <span>
            <span className="block text-base text-muted">Rejected, last 24 h</span>
            <span className="block text-4xl font-semibold tabular-nums">{s.rejected_24h.toLocaleString('en-IN')}</span>
            <span className="block text-sm text-muted">
              {rate !== null ? `${rate} % accepted · ` : ''}Last {s.last_rejected_at ? `${fmtAgo(s.last_rejected_at).toLowerCase()} · ${fmtWhen(s.last_rejected_at)}` : 'never'}
            </span>
          </span>
        </button>
        <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2 xl:col-span-1">
          <div>
            <p className="mb-1.5 text-base font-semibold">Accepted by type · 24 h</p>
            {s.by_type_24h.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {s.by_type_24h.map((t) => (
                  <li key={t.type}>
                    <Badge>
                      {t.type} <span className="font-semibold tabular-nums">{t.n.toLocaleString('en-IN')}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nothing received in 24 h.</p>
            )}
          </div>
          <div>
            <p className="mb-1.5 text-base font-semibold">Why rejected · 7 days</p>
            {s.rejected_by_error_7d.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {s.rejected_by_error_7d.slice(0, 4).map((e) => (
                  <li key={e.error} className="flex justify-between gap-3">
                    <span className="truncate">{humanize(e.error)}</span>
                    <span className="font-semibold tabular-nums">{e.n}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No rejections in 7 days.</p>
            )}
          </div>
        </div>
      </div>
    </Band>
  );
}

/** Each day shaded by messages accepted (or, on the Rejected tab, rejected); a red dot when some were rejected. */
function IngestCalendar({ day, onDay, focus }: { day: string | null; onDay: (d: string | null) => void; focus: 'accepted' | 'rejected' }) {
  const [month, setMonth] = useState((day ?? istToday()).slice(0, 7));
  const q = useQuery({
    queryKey: ['ingest', 'calendar', month],
    queryFn: () => api.get<IngestCalendarDayDto[]>('/ingest/calendar', { month }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const byDay = new Map((q.data ?? []).map((x) => [x.date, x]));
  const picked = day ? byDay.get(day) : undefined;
  return (
    <MonthCalendar
      month={month}
      onMonth={setMonth}
      loading={q.isFetching && !q.data}
      value={(c) => ({ n: byDay.get(c)?.[focus] ?? 0, alert: byDay.get(c)?.rejected ?? 0 })}
      label={(n) => `${n.toLocaleString('en-IN')} ${focus}`}
      alertLabel="some rejected"
      day={day}
      onDay={onDay}
    >
      {day && (
        <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
          <p className="font-semibold">{dayTitle(day)}</p>
          <p className="mt-1">
            {(picked?.accepted ?? 0).toLocaleString('en-IN')} accepted · <span className={picked?.rejected ? 'font-medium text-fault' : 'text-muted'}>{picked?.rejected ?? 0} rejected</span>
          </p>
        </div>
      )}
    </MonthCalendar>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>;
}

function MessagesTab({ day }: { day: string | null }) {
  const [robot, setRobot] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['ingest', 'messages', { robot, type, page, day }],
    queryFn: () => api.get<Paginated<IngestLogItemDto>>('/ingest/messages', { robot: robotFilter(robot), type, page, limit: LIMIT, ...(day ? dayBounds(day) : {}) }),
    placeholderData: keepPreviousData,
  });
  const detail = useQuery({ queryKey: ['ingest', 'message', open], queryFn: () => api.get<IngestLogItemDto>(`/ingest/messages/${open}`), enabled: !!open });

  return (
    <div className="flex flex-col gap-3">
      <form aria-label="Filter messages" className="grid gap-3 sm:grid-cols-3 sm:items-end" onSubmit={(e) => e.preventDefault()}>
        <Field label="Robot ID">
          <Input value={robot} onChange={(e) => { setRobot(e.target.value); setPage(1); }} placeholder="e.g. saibya01" />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
            <option value="">All types</option>
            {['hello', 'live', 'telemetry', 'event', 'mission', 'detection'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </form>
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.items.length && page === 1 ? (
        <EmptyState title={day || robot || type ? 'No messages for these filters' : 'No messages yet'} description={day || robot || type ? 'Try another day, robot or type.' : 'Connect a robot or the GCS relay.'} />
      ) : (
        <>
          <DataTable
            caption="Accepted messages"
            dense
            rows={q.data?.items ?? []}
            rowKey={(m) => m.msg_id}
            onRowClick={(m) => setOpen(m.msg_id)}
            columns={[
              { key: 'rx', header: 'Received', rowHeader: true, className: 'whitespace-nowrap', cell: (m) => <span title={`Captured ${fmtWhen(m.ts)}`}>{fmtWhen(m.received_at)}</span> },
              { key: 'r', header: 'Robot', cell: (m) => <RobotRef id={m.robot_id} detail={false} onClick={(e) => e.stopPropagation()} /> },
              { key: 't', header: 'Type', cell: (m) => <Badge>{m.type}</Badge> },
              { key: 'c', header: 'Sent by', cell: (m) => <span className="whitespace-nowrap">{m.client_name ?? '—'} · {m.transport.toUpperCase()}</span> },
              {
                key: 'id',
                header: 'msg_id',
                cell: (m) => (
                  <button type="button" className="font-mono text-xs text-accent-text hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(m.msg_id); }} aria-label={`View raw message ${m.msg_id}`}>
                    {m.msg_id.slice(0, 8)}…
                  </button>
                ),
              },
            ]}
          />
          {q.data && <Pagination page={page} limit={LIMIT} total={q.data.total} onPage={setPage} />}
        </>
      )}
      <Dialog open={!!open} onClose={() => setOpen(null)} title="Raw message" description={open ?? undefined} size="lg">
        {detail.isLoading ? <LoadingBlock rows={4} /> : detail.error ? <ErrorState error={detail.error} /> : <JsonBlock value={detail.data?.raw ?? detail.data} />}
      </Dialog>
    </div>
  );
}

function RejectionsTab({ day, errors }: { day: string | null; errors: { error: string; n: number }[] }) {
  const [page, setPage] = useState(1);
  const [robot, setRobot] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<IngestRejectionDto | null>(null);
  const q = useQuery({
    queryKey: ['ingest', 'rejections', page, robot, error, day],
    queryFn: () =>
      api.get<Paginated<IngestRejectionDto>>('/ingest/rejections', { page, limit: LIMIT, robot: robotFilter(robot), error: error || undefined, ...(day ? dayBounds(day) : {}) }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="flex flex-col gap-3">
      <form aria-label="Filter rejected messages" className="grid gap-3 sm:grid-cols-3 sm:items-end" onSubmit={(e) => e.preventDefault()}>
        <Field label="Robot ID">
          <Input value={robot} onChange={(e) => { setRobot(e.target.value); setPage(1); }} placeholder="e.g. saibya01" />
        </Field>
        <Field label="Reason">
          <Select value={error} onChange={(e) => { setError(e.target.value); setPage(1); }}>
            <option value="">All reasons</option>
            {errors.map((x) => (
              <option key={x.error} value={x.error}>
                {humanize(x.error)} ({x.n})
              </option>
            ))}
          </Select>
        </Field>
      </form>
      <p className="text-sm text-muted">
        Common causes: <Mono>clock_ahead</Mono>/<Mono>clock_unsynced</Mono> (robot or GCS clock not NTP-synced), <Mono>robot_not_allowed</Mono> (key used for another robot),
        <Mono>product_mismatch</Mono>, <Mono>unknown_robot</Mono>, invalid payload.
      </p>
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.items.length && page === 1 ? (
        <EmptyState title="No rejected messages" description={day || robot || error ? 'Nothing was rejected for these filters.' : 'Everything received so far passed validation.'} />
      ) : (
        <>
          <DataTable
            caption="Rejected messages"
            dense
            rows={q.data?.items ?? []}
            rowKey={(r) => String(r.id)}
            onRowClick={setOpen}
            columns={[
              { key: 'rx', header: 'Received', rowHeader: true, className: 'whitespace-nowrap', cell: (r) => fmtWhen(r.received_at) },
              { key: 'e', header: 'Reason', cell: (r) => <Badge tone="fault">{humanize(r.error)}</Badge> },
              { key: 'r', header: 'Robot', cell: (r) => (r.robot_id ? <RobotRef id={r.robot_id} detail={false} onClick={(e) => e.stopPropagation()} /> : '—') },
              { key: 't', header: 'Type', cell: (r) => r.type ?? '—' },
              { key: 'c', header: 'Client', cell: (r) => r.client_name ?? '—' },
              { key: 'm', header: 'msg_id', cell: (r) => (r.msg_id ? <span className="font-mono text-xs">{r.msg_id.slice(0, 8)}…</span> : '—') },
              {
                key: 'v',
                header: <span className="sr-only">Details</span>,
                cell: (r) => (
                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setOpen(r); }} aria-label={`Details of rejection ${r.id}`}>
                    Details
                  </Button>
                ),
              },
            ]}
          />
          {q.data && <Pagination page={page} limit={LIMIT} total={q.data.total} onPage={setPage} />}
        </>
      )}
      <Dialog open={!!open} onClose={() => setOpen(null)} title={`Rejected: ${open?.error ?? ''}`} size="lg">
        {open && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Details</h3>
            <JsonBlock value={open.details} />
            {open.raw !== undefined && (
              <>
                <h3 className="text-sm font-semibold">Raw input</h3>
                <JsonBlock value={open.raw} />
              </>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
