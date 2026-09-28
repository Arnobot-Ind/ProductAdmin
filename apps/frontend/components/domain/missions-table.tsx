'use client';

import type { MissionListItemDto, Paginated } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FileVideo } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Field, Select } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingBlock, Pagination, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { fmtDistance, fmtDuration } from '@/lib/format';
import { useLivePoll } from '@/lib/realtime';
import { MissionResultBadge } from './status';

const LIMIT = 50;

/** A mission always belongs to one robot, so its page lives under that robot. */
export const missionHref = (m: { robot_id: string; mission_id: string }) =>
  `/robots/${m.robot_id}/missions/${encodeURIComponent(m.mission_id)}`;

export interface MissionFilters {
  result?: string;
  page: number;
}

/** One robot's missions. Spec §5 view 2: Mission ID · Start · End · Duration · Distance · Result · End reason. */
export function MissionsTable({ filters, onFilters, robotId }: { filters: MissionFilters; onFilters: (p: Partial<MissionFilters>) => void; robotId: string }) {
  const router = useRouter();
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['robot', robotId, 'missions', filters],
    queryFn: () =>
      api.get<Paginated<MissionListItemDto>>(`/robots/${robotId}/missions`, {
        result: filters.result,
        page: filters.page,
        limit: LIMIT,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: poll,
  });

  return (
    <div className="flex flex-col gap-3">
      <form aria-label="Filter missions" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end" onSubmit={(e) => e.preventDefault()}>
        <Field label="Result">
          <Select value={filters.result ?? ''} onChange={(e) => onFilters({ result: e.target.value || undefined, page: 1 })}>
            <option value="">All results</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="aborted">Aborted</option>
            <option value="in_progress">In progress</option>
          </Select>
        </Field>
      </form>
      {q.isLoading ? (
        <LoadingBlock rows={6} label="Loading missions" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (q.data?.items.length ?? 0) === 0 && filters.page === 1 ? (
        <EmptyState title="No missions" description="The GCS creates and runs missions; the robot reports start and end, and the GCS sends the completed report." />
      ) : (
        <>
          <DataTable
            caption="Missions"
            rows={q.data?.items ?? []}
            rowKey={(m) => m.mission_id}
            onRowClick={(m) => router.push(missionHref(m))}
            columns={[
              {
                key: 'id',
                header: 'Mission ID',
                rowHeader: true,
                cell: (m) => (
                  <Link href={missionHref(m)} className="font-mono font-semibold text-accent-text hover:underline" onClick={(e) => e.stopPropagation()}>
                    {m.mission_id}
                  </Link>
                ),
              },
              { key: 'start', header: 'Start', cell: (m) => <Time iso={m.started_at} /> },
              { key: 'end', header: 'End', cell: (m) => <Time iso={m.ended_at} /> },
              { key: 'dur', header: 'Duration', align: 'right', cell: (m) => fmtDuration(m.duration_s) },
              { key: 'dist', header: 'Distance', align: 'right', cell: (m) => fmtDistance(m.distance_m) },
              { key: 'res', header: 'Result', cell: (m) => <MissionResultBadge result={m.result} /> },
              { key: 'reason', header: 'End reason', cell: (m) => m.end_reason ?? <span className="text-muted">—</span> },
              {
                key: 'files',
                header: 'Files',
                align: 'right',
                cell: (m) =>
                  m.file_count ? (
                    <span className="inline-flex items-center gap-1">
                      <FileVideo className="size-3.5" aria-hidden />
                      {m.file_count}
                    </span>
                  ) : (
                    '0'
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
