'use client';

import type { EventDto, Paginated } from '@arnobot/message-schema';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Badge, EmptyState, ErrorState, LoadingBlock, Pagination, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fromLocalInput, toLocalInput } from '@/lib/format';
import { useLivePoll } from '@/lib/realtime';
import { EVENT_SEVERITIES, EVENT_TYPES } from '@/lib/schema';
import { SeverityBadge, eventTypeLabel } from './status';

const LIMIT = 50;

export interface EventFilters {
  robot?: string;
  type?: string;
  severity?: string;
  unacked?: boolean;
  from?: string;
  to?: string;
  page: number;
}

/**
 * Event log (spec §3 row 13): Time (UTC shown local) · Type · Severity · Message · Acknowledged by + time.
 * Filters are controlled by the parent (URL state on the global page, local state on a robot tab).
 */
export function EventsTable({
  filters,
  onFilters,
  robotId,
  showRobotFilter,
}: {
  filters: EventFilters;
  onFilters: (patch: Partial<EventFilters>) => void;
  robotId?: string;
  showRobotFilter?: boolean;
}) {
  const can = useCan();
  const canAck = can('event.ack');
  const qc = useQueryClient();
  const toast = useToast();
  const poll = useLivePoll();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const robot = robotId ?? filters.robot;

  const key: QueryKey = robotId ? ['robot', robotId, 'events', filters] : ['events', filters];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.get<Paginated<EventDto>>(robotId ? `/robots/${robotId}/events` : '/events', {
        robot: robotId ? undefined : robot,
        type: filters.type,
        severity: filters.severity,
        unacked: filters.unacked,
        from: filters.from,
        to: filters.to,
        page: filters.page,
        limit: LIMIT,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: poll,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['events'] });
    void qc.invalidateQueries({ queryKey: ['robot'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const ackOne = useMutation({
    mutationFn: (id: string) => api.post<EventDto>(`/events/${id}/ack`),
    onSuccess: () => {
      toast.success('Event acknowledged');
      invalidate();
    },
    onError: toast.error,
  });
  const ackMany = useMutation({
    mutationFn: (ids: string[]) => api.post<{ acknowledged: number }>('/events/ack', { ids }),
    onSuccess: (r) => {
      toast.success(`${r.acknowledged} event(s) acknowledged`);
      setSelected(new Set());
      invalidate();
    },
    onError: toast.error,
  });

  const items = q.data?.items ?? [];
  const unackedOnPage = items.filter((e) => !e.acknowledged_at);
  const allSelected = unackedOnPage.length > 0 && unackedOnPage.every((e) => selected.has(e.id));

  return (
    <div className="flex flex-col gap-3">
      <form aria-label="Filter events" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" onSubmit={(e) => e.preventDefault()}>
        {showRobotFilter && (
          <Field label="Robot ID">
            <Input value={filters.robot ?? ''} onChange={(e) => onFilters({ robot: e.target.value || undefined, page: 1 })} placeholder="e.g. saibya01" />
          </Field>
        )}
        <Field label="Type">
          <Select value={filters.type ?? ''} onChange={(e) => onFilters({ type: e.target.value || undefined, page: 1 })}>
            <option value="">All types</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {eventTypeLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Severity">
          <Select value={filters.severity ?? ''} onChange={(e) => onFilters({ severity: e.target.value || undefined, page: 1 })}>
            <option value="">All severities</option>
            {EVENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From (local time)">
          <Input type="datetime-local" value={toLocalInput(filters.from)} onChange={(e) => onFilters({ from: fromLocalInput(e.target.value), page: 1 })} />
        </Field>
        <Field label="To (local time)">
          <Input type="datetime-local" value={toLocalInput(filters.to)} onChange={(e) => onFilters({ to: fromLocalInput(e.target.value), page: 1 })} />
        </Field>
        <Checkbox label="Unacknowledged only" checked={!!filters.unacked} onChange={(e) => onFilters({ unacked: e.target.checked || undefined, page: 1 })} className="h-10" />
      </form>

      {canAck && selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span>{selected.size} selected</span>
          <Button size="sm" variant="primary" loading={ackMany.isPending} onClick={() => ackMany.mutate([...selected])} icon={<CheckCheck className="size-4" aria-hidden />}>
            Acknowledge selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {q.isLoading ? (
        <LoadingBlock rows={6} label="Loading events" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 && filters.page === 1 ? (
        <EmptyState title="No events" description="Abort, RTH, alert, fault and update events appear here as robots send them." />
      ) : (
        <>
          <DataTable
            caption="Events"
            rows={items}
            rowKey={(e) => e.id}
            rowClassName={(e) => (!e.acknowledged_at && e.severity === 'critical' ? 'bg-fault-bg/40' : undefined)}
            columns={[
              ...(canAck
                ? [
                    {
                      key: 'sel',
                      header: (
                        <input
                          type="checkbox"
                          aria-label="Select all unacknowledged events on this page"
                          checked={allSelected}
                          disabled={!unackedOnPage.length}
                          onChange={(e) => setSelected(e.target.checked ? new Set(unackedOnPage.map((x) => x.id)) : new Set())}
                          className="size-4 accent-[var(--accent)]"
                        />
                      ),
                      cell: (e: EventDto) =>
                        e.acknowledged_at ? null : (
                          <input
                            type="checkbox"
                            aria-label={`Select event: ${e.message}`}
                            checked={selected.has(e.id)}
                            onChange={(ev) => {
                              const next = new Set(selected);
                              if (ev.target.checked) next.add(e.id);
                              else next.delete(e.id);
                              setSelected(next);
                            }}
                            className="size-4 accent-[var(--accent)]"
                          />
                        ),
                    },
                  ]
                : []),
              { key: 'ts', header: 'Time', cell: (e) => <Time iso={e.ts} /> },
              ...(robotId
                ? []
                : [
                    {
                      key: 'robot',
                      header: 'Robot',
                      cell: (e: EventDto) => (
                        <Link className="font-mono text-accent-text hover:underline" href={`/robots/${e.robot_id}?tab=events`}>
                          {e.robot_id}
                        </Link>
                      ),
                    },
                  ]),
              { key: 'type', header: 'Type', cell: (e) => <Badge>{eventTypeLabel(e.type)}</Badge> },
              { key: 'sev', header: 'Severity', cell: (e) => <SeverityBadge severity={e.severity} /> },
              {
                key: 'msg',
                header: 'Message',
                className: 'min-w-64',
                cell: (e) => (
                  <span>
                    {e.message}
                    {e.code && <span className="ml-2 font-mono text-xs text-muted">{e.code}</span>}
                  </span>
                ),
              },
              {
                key: 'ack',
                header: 'Acknowledged',
                cell: (e) =>
                  e.acknowledged_at ? (
                    <span className="text-xs">
                      {e.acknowledged_by_name ?? '—'}
                      <br />
                      <Time iso={e.acknowledged_at} />
                    </span>
                  ) : canAck ? (
                    <Button size="sm" onClick={() => ackOne.mutate(e.id)} loading={ackOne.isPending && ackOne.variables === e.id} aria-label={`Acknowledge event: ${e.message}`}>
                      Acknowledge
                    </Button>
                  ) : (
                    <Badge tone="warn">Open</Badge>
                  ),
              },
            ]}
          />
          {q.data && <Pagination page={filters.page} limit={LIMIT} total={q.data.total} onPage={(p) => onFilters({ page: p })} />}
        </>
      )}
    </div>
  );
}
