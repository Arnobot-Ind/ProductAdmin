'use client';

import { EVENT_SEVERITIES, EVENT_TYPES, type ClientEventDto, type EventSeverity, type EventType, type Paginated, type RobotListItemDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { eventTypeLabel, SeverityBadge } from '@/components/common/status';
import { Field, Select } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingBlock, Pagination } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';

const fmtIst = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const LIMIT = 50;

/**
 * Events and alerts (portal.events.view, 0021): of one robot, or of every robot the user may see (with a robot filter).
 * Customer-safe rows only: no raw payload, no acknowledging staff member. No CSV, by design.
 */
export function ClientEvents({ robotId, robots }: { robotId?: string; robots?: RobotListItemDto[] }) {
  const [robot, setRobot] = useState('');
  const [type, setType] = useState<EventType | ''>('');
  const [severity, setSeverity] = useState<EventSeverity | ''>('');
  const [page, setPage] = useState(1);
  const path = robotId ? `/robots/${robotId}/client/events` : '/client/events';
  const q = useQuery({
    queryKey: ['portal', 'events', robotId ?? robot, type, severity, page],
    queryFn: () => api.get<Paginated<ClientEventDto>>(path, { robot: robotId ? undefined : robot, type, severity, page, limit: LIMIT }),
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
  });
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
        {!robotId && (
          <Field label="Robot" className="w-full sm:w-48">
            <Select value={robot} onChange={(e) => filter(setRobot)(e.target.value)}>
              <option value="">All robots</option>
              {(robots ?? []).map((r) => (
                <option key={r.robot_id} value={r.robot_id}>
                  {r.robot_id.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Type" className="w-full sm:w-40">
          <Select value={type} onChange={(e) => filter(setType)(e.target.value as EventType | '')}>
            <option value="">All types</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {eventTypeLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Severity" className="w-full sm:w-40">
          <Select value={severity} onChange={(e) => filter(setSeverity)(e.target.value as EventSeverity | '')}>
            <option value="">All severities</option>
            {EVENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
      </form>

      {q.isLoading ? (
        <LoadingBlock rows={5} label="Loading events" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <DataTable
            caption="Events"
            rows={q.data!.items}
            rowKey={(e) => e.id}
            empty={<EmptyState title="No events" description={type || severity || robot ? 'Nothing matches these filters.' : 'No alerts, faults, aborts or returns home were reported.'} />}
            columns={[
              { key: 'ts', header: 'Time (IST)', rowHeader: true, cell: (e) => <span className="whitespace-nowrap tabular-nums">{fmtIst(e.ts)}</span> },
              ...(robotId
                ? []
                : [
                    {
                      key: 'robot',
                      header: 'Robot',
                      cell: (e: ClientEventDto) => (
                        <Link href={`/robots/${e.robot_id}?tab=events`} className="font-mono font-semibold text-accent-text hover:underline">
                          {e.robot_id.toUpperCase()}
                        </Link>
                      ),
                    },
                  ]),
              { key: 'type', header: 'Type', cell: (e) => eventTypeLabel(e.type) },
              { key: 'sev', header: 'Severity', cell: (e) => <SeverityBadge severity={e.severity} /> },
              { key: 'msg', header: 'Message', cell: (e) => <span>{e.message}</span> },
            ]}
          />
          {q.data!.total > LIMIT && <Pagination page={page} limit={LIMIT} total={q.data!.total} onPage={setPage} />}
        </>
      )}
    </div>
  );
}
