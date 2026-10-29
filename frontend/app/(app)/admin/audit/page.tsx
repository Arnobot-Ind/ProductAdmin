'use client';

import { RobotRef } from '@/components/domain/robot-ref';

import type { AuditCalendarDayDto, AuditEntryDto, Paginated } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, ScrollText, X } from 'lucide-react';
import { CalendarLayout, dayBounds, dayTitle, istToday, MonthCalendar } from '@/components/domain/activity-calendar';
import { useState } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge, EmptyState, InlineAlert, PageHeader, Pagination, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api, downloadUrl, qs } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDateTime, fmtWhen, fromLocalInput } from '@/lib/format';
import { useDebounced, useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useCompanies } from '@/lib/queries';
import { ACTION_LABEL, auditSummary } from '@/lib/audit';

const ACTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All events' },
  { value: 'auth.', label: 'Sign-ins & passwords' },
  { value: 'data.', label: 'Data access (views, downloads, deletes)' },
  { value: 'data.downloaded', label: '· Downloads' },
  { value: 'data.viewed', label: '· Recordings opened' },
  { value: 'robot.assigned', label: 'Robot assignments' },
  { value: 'grant.', label: 'Permission changes' },
  { value: 'user.', label: 'User changes' },
  { value: 'org.', label: 'Organization changes' },
  { value: 'access.denied', label: 'Refused requests' },
  { value: 'credential.', label: 'Credentials (stored, revealed, rotated, revoked)' },
  { value: 'client.updated', label: 'Client profile changes' },
  { value: 'features.updated', label: 'Client feature changes' },
  { value: 'access.updated', label: 'User access changes' },
  { value: 'software.', label: 'Software (client installs, robot updates)' },
];

export default function AuditPage() {
  useDocumentTitle('Audit log');
  const can = useCan();
  const companies = useCompanies(can('audit.read'));
  const [f, setF] = useState({ action: '', outcome: '', company_id: '', robot: '', q: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  // A day picked on the calendar (IST, kept in the URL) replaces From / To.
  const [url, setUrl] = useUrlState();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(url.get('day') ?? '') ? url.get('day') : null;
  const setDay = (d: string | null) => {
    setUrl({ day: d });
    setPage(1);
  };
  const text = useDebounced(f.q, 300);
  const robot = useDebounced(f.robot.trim().toLowerCase(), 300);
  const params = {
    action: f.action || undefined,
    outcome: f.outcome || undefined,
    company_id: f.company_id || undefined,
    robot: /^[a-z][a-z0-9_]*[0-9]+$/.test(robot) ? robot : undefined,
    q: text || undefined,
    from: day ? dayBounds(day).from : fromLocalInput(f.from),
    to: day ? dayBounds(day).to : fromLocalInput(f.to),
  };
  // The calendar counts with the same filters, minus the dates.
  const { from: _from, to: _to, ...calendarFilters } = params;
  const q = useQuery({
    queryKey: ['audit', params, page],
    queryFn: () => api.get<Paginated<AuditEntryDto>>('/audit', { ...params, page, limit: 50 }),
    enabled: can('audit.read'),
    placeholderData: (prev) => prev,
  });
  const set = (patch: Partial<typeof f>) => {
    setF({ ...f, ...patch });
    setPage(1);
  };

  if (!can('audit.read')) {
    return (
      <>
        <PageHeader title="Audit log" />
        <InlineAlert tone="fault">You don&apos;t have permission to read the audit log.</InlineAlert>
      </>
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="Access"
        title="Audit log"
        description="Who signed in, who opened or downloaded which robot's data, robot assignments, permission changes and refused requests. Entries cannot be edited or deleted."
        actions={
          <a
            href={downloadUrl(`/audit/export.csv${qs(params)}`)}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2"
          >
            <Download className="size-4" aria-hidden /> Export CSV
          </a>
        }
      />
      <CalendarLayout calendar={<AuditCalendar filters={calendarFilters} day={day} onDay={setDay} />}>
      {day && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent/40 bg-accent-soft px-4 py-2.5">
          <p className="text-base font-semibold text-accent-text">{dayTitle(day)}</p>
          <button type="button" onClick={() => setDay(null)} className="inline-flex items-center gap-1 text-sm font-medium text-accent-text hover:underline">
            <X className="size-4" aria-hidden /> All days
          </button>
        </div>
      )}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        <Field label="Event">
          <Select value={f.action} onChange={(e) => set({ action: e.target.value })}>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Outcome">
          <Select value={f.outcome} onChange={(e) => set({ outcome: e.target.value })}>
            <option value="">Any</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="failure">Failed</option>
          </Select>
        </Field>
        <Field label="Organization">
          <Select value={f.company_id} onChange={(e) => set({ company_id: e.target.value })}>
            <option value="">Any</option>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Robot">
          <Input value={f.robot} onChange={(e) => set({ robot: e.target.value })} placeholder="saibya02" />
        </Field>
        <Field label="Search">
          <Input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="email, name, file…" />
        </Field>
        {!day && (
          <>
            <Field label="From">
              <Input type="datetime-local" value={f.from} onChange={(e) => set({ from: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="datetime-local" value={f.to} onChange={(e) => set({ to: e.target.value })} />
            </Field>
          </>
        )}
      </div>
      <QueryView query={q} rows={12}>
        {(res) =>
          res.items.length === 0 ? (
            <EmptyState icon={<ScrollText className="size-8" />} title="No audit entries" description="Nothing matches these filters." />
          ) : (
            <>
              <DataTable
                caption="Audit log entries"
                dense
                rows={res.items}
                rowKey={(e) => e.id}
                columns={[
                  { key: 't', header: 'When', className: 'whitespace-nowrap', cell: (e) => <span title={fmtDateTime(e.at)}>{fmtWhen(e.at)}</span> },
                  {
                    key: 'w',
                    header: 'Who',
                    rowHeader: true,
                    cell: (e) => (
                      <span>
                        <span className="font-medium">{e.actor_name ?? e.actor_email ?? 'Unknown'}</span>
                        {e.actor_name && <span className="block text-xs text-muted">{e.actor_email}</span>}
                      </span>
                    ),
                  },
                  {
                    key: 'a',
                    header: 'Event',
                    cell: (e) => (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {ACTION_LABEL[e.action] ?? e.action}
                        {e.outcome !== 'success' && <Badge tone={e.outcome === 'denied' ? 'fault' : 'warn'}>{e.outcome}</Badge>}
                      </span>
                    ),
                  },
                  { key: 'r', header: 'Robot', cell: (e) => (e.robot_id ? <RobotRef id={e.robot_id} /> : <span className="text-muted">—</span>) },
                  { key: 'o', header: 'Organization', cell: (e) => (e.company_name ? <span className="block max-w-44 truncate" title={e.company_name}>{e.company_name}</span> : <span className="text-muted">—</span>) },
                  { key: 'd', header: 'Details', className: 'max-w-md', cell: (e) => <span className="block truncate text-xs text-muted" title={JSON.stringify(e.detail)}>{auditSummary(e)}</span> },
                  { key: 'i', header: 'IP', cell: (e) => <span className="font-mono text-xs">{e.ip ?? '—'}</span> },
                ]}
              />
              <Pagination page={res.page} limit={res.limit} total={res.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
      </CalendarLayout>
    </>
  );
}

/** The month on a calendar, each day shaded by its audit entries; a red dot when some were refused or failed. */
function AuditCalendar({ filters, day, onDay }: { filters: Record<string, string | undefined>; day: string | null; onDay: (d: string | null) => void }) {
  const [month, setMonth] = useState((day ?? istToday()).slice(0, 7));
  const q = useQuery({
    queryKey: ['audit', 'calendar', month, filters],
    queryFn: () => api.get<AuditCalendarDayDto[]>('/audit/calendar', { ...filters, month }),
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
      value={(c) => ({ n: byDay.get(c)?.total ?? 0, alert: byDay.get(c)?.problems ?? 0 })}
      label={(n) => `${n} entr${n === 1 ? 'y' : 'ies'}`}
      alertLabel="refused or failed"
      day={day}
      onDay={onDay}
    >
      {day && (
        <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
          <p className="font-semibold">{dayTitle(day)}</p>
          <p className="mt-1">
            {picked?.total ?? 0} entr{picked?.total === 1 ? 'y' : 'ies'} · <span className={picked?.problems ? 'font-medium text-fault' : 'text-muted'}>{picked?.problems ?? 0} refused or failed</span>
          </p>
        </div>
      )}
    </MonthCalendar>
  );
}

