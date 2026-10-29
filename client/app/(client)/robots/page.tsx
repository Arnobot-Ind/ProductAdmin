'use client';

import type { Paginated, RobotListItemDto, RobotStatus } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { BatteryMedium, ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { RobotStatusBadge } from '@/components/common/status';
import { Input } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtRelative } from '@/lib/format';
import { useDocumentTitle, useNow } from '@/lib/hooks';

const FILTERS: { id: 'all' | RobotStatus; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'stale', label: 'Stale' },
  { id: 'offline', label: 'Offline' },
];

/** The client's robots: status at a glance, each opening its missions and reports. */
export default function PortalRobotsPage() {
  useDocumentTitle('Your robots');
  const me = useMe();
  const now = useNow(10_000);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | RobotStatus>('all');
  const q = useQuery({
    queryKey: ['portal', 'robots'],
    queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { limit: 200 }),
    refetchInterval: 60_000,
  });
  const all = q.data?.items ?? [];
  const term = search.trim().toLowerCase();
  const robots = all.filter((r) => (status === 'all' || r.status === status) && (!term || r.robot_id.includes(term) || r.product_name.toLowerCase().includes(term)));
  const count = (id: 'all' | RobotStatus) => (id === 'all' ? all.length : all.filter((r) => r.status === id).length);

  return (
    <>
      <PageHeader eyebrow={me.organization.name} title="Your robots" description="Live status of each robot. Open a robot for its missions, day-wise report and distance by day." />
      {q.isLoading ? (
        <LoadingBlock rows={4} label="Loading robots" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !all.length ? (
        <EmptyState title="No robots yet" description="No robot is assigned to your organization yet. Contact Arnobot to have your robots added." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="relative w-full sm:w-64">
              <span className="sr-only">Search robots</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by robot or model" className="pl-8" />
            </label>
            <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={status === f.id}
                  onClick={() => setStatus(f.id)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-sm transition-colors',
                    status === f.id ? 'border-accent bg-accent-soft font-semibold text-accent-text' : 'border-border text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {f.label} <span className="tabular-nums">{count(f.id)}</span>
                </button>
              ))}
            </div>
          </div>
          {!robots.length ? (
            <EmptyState title="No matching robots" description="Change the search or the status filter." />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {robots.map((r) => (
                <li key={r.robot_id}>
                  <Link
                    href={`/robots/${r.robot_id}`}
                    className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-lg font-bold">{r.robot_id.toUpperCase()}</p>
                        <p className="truncate text-sm text-muted">{r.product_name}</p>
                      </div>
                      <RobotStatusBadge lastSeenAt={r.last_seen_at} />
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <div>
                        <dt className="text-xs text-muted">Last seen</dt>
                        <dd>{r.last_seen_at ? fmtRelative(r.last_seen_at, now) : 'Never'}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Battery</dt>
                        <dd className="inline-flex items-center gap-1">
                          <BatteryMedium className="size-4 text-muted" aria-hidden />
                          {r.battery_pct === null ? '—' : `${Math.round(r.battery_pct)} %`}
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-xs text-muted">Current mission</dt>
                        <dd className="truncate">{r.current_mission_id ? (r.current_mission_name ?? 'On a mission') : 'None'}</dd>
                      </div>
                    </dl>
                    <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-accent-text">
                      Missions and reports
                      <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
