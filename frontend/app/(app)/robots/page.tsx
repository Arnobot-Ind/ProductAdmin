'use client';

import type { DashboardDto, DeviceHealthDto, Paginated, ProductDto, RobotListItemDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertOctagon, Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RobotStatusBadge } from '@/components/domain/status';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { Badge, EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from '@/components/ui/misc';
import { DataTable, type Column, type SortState } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtPct } from '@/lib/format';
import { useDebounced, useDocumentTitle, useNow, useUrlState } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

const LIMIT = 50;

export default function RobotsPage() {
  useDocumentTitle('Robots');
  const can = useCan();
  const router = useRouter();
  const poll = useLivePoll();
  const now = useNow(5000);
  const [params, setParams] = useUrlState();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search, 300);

  const product = params.get('product') ?? '';
  const status = params.get('status') ?? '';
  const includeDeleted = params.get('include_deleted') === 'true';
  const page = Number(params.get('page') ?? 1) || 1;
  const sortParam = params.get('sort') ?? 'robot_id';
  const sort: SortState = sortParam.startsWith('-') ? { key: sortParam.slice(1), dir: 'desc' } : { key: sortParam, dir: 'asc' };
  const filtered = Boolean(q || product || status || includeDeleted);

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParams({ q, page: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const clearFilters = () => {
    setSearch('');
    setParams({ q: null, product: null, status: null, include_deleted: null, page: null });
  };

  // Fleet counts for the status chips (same scope as the list).
  const counts = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardDto>('/dashboard'), refetchInterval: poll || 30_000 });
  const products = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.get<ProductDto[]>('/products'), enabled: can('catalog.read'), staleTime: 300_000 });
  const robots = useQuery({
    queryKey: ['robots', { q, product, status, includeDeleted, page, sortParam }],
    queryFn: () =>
      api.get<Paginated<RobotListItemDto>>('/robots', {
        q,
        product,
        status,
        include_deleted: includeDeleted,
        sort: sortParam,
        page,
        limit: LIMIT,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: poll,
  });

  const columns = robotColumns(now);

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Robots"
        description="Every robot, what it is doing and whether it needs attention. Click a row to open the robot."
        actions={can('robot.write') ? <LinkButton href="/robots/new" variant="primary" icon={<Plus className="size-4" aria-hidden />}>Register robot</LinkButton> : undefined}
      />

      <div className="mb-3 rounded-lg border border-border bg-surface p-3">
        <form role="search" aria-label="Filter robots" className="flex flex-wrap items-center gap-2" onSubmit={(e) => e.preventDefault()}>
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search robot ID or serial number" aria-label="Search robots" className="pl-9" type="search" />
          </div>
          {can('catalog.read') && (
            <Select value={product} onChange={(e) => setParams({ product: e.target.value || null, page: null })} aria-label="Product" className="w-48">
              <option value="">All products</option>
              {products.data?.map((p) => (
                <option key={p.id} value={p.code}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setParams({ include_deleted: e.target.checked ? 'true' : null, page: null })} className="h-10 px-1" />
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            {(
              [
                ['', 'All', counts.data?.robots_total, 'bg-accent'],
                ['online', 'Online', counts.data?.by_status.online, 'bg-ok'],
                ['stale', 'Stale', counts.data?.by_status.stale, 'bg-warn'],
                ['offline', 'Offline', counts.data?.by_status.offline, 'bg-offline'],
              ] as const
            ).map(([value, label, n, dot]) => (
              <button
                key={label}
                type="button"
                aria-pressed={status === value}
                onClick={() => setParams({ status: value || null, page: null })}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                  status === value ? 'border-accent bg-accent-soft text-accent-text' : 'border-border bg-surface hover:bg-surface-2',
                )}
              >
                <span className={cn('size-2 rounded-full', dot)} aria-hidden />
                {label}
                <span className="tabular-nums text-muted">{n ?? '…'}</span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            {robots.data && (
              <span aria-live="polite">
                {robots.data.total.toLocaleString()} robot{robots.data.total === 1 ? '' : 's'}
                {filtered && ' match'}
              </span>
            )}
            {filtered && (
              <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline">
                <X className="size-3.5" aria-hidden /> Clear filters
              </button>
            )}
          </div>
        </div>
      </div>

      {robots.isLoading ? (
        <LoadingBlock rows={8} label="Loading robots" />
      ) : robots.error ? (
        <ErrorState error={robots.error} onRetry={() => void robots.refetch()} />
      ) : robots.data && robots.data.total === 0 && !filtered ? (
        <EmptyState
          title="No robots registered yet"
          description="Register a robot to get its permanent Robot ID and ingest key. Until real robots are online, run the simulator (npm run sim)."
          action={can('robot.write') ? <LinkButton href="/robots/new" variant="primary">Register robot</LinkButton> : undefined}
        />
      ) : (
        <>
          <div className={cn('transition-opacity', robots.isPlaceholderData && 'opacity-60')} aria-busy={robots.isPlaceholderData}>
            <DataTable
              caption="Robots"
              rows={robots.data?.items ?? []}
              rowKey={(r) => r.robot_id}
              sort={sort}
              onSort={(s) => setParams({ sort: s.dir === 'desc' ? `-${s.key}` : s.key, page: null })}
              onRowClick={(r) => router.push(`/robots/${r.robot_id}`)}
              rowClassName={(r) => cn(r.deleted_at && 'opacity-60', r.unacked_critical_events > 0 && 'shadow-[inset_3px_0_0_var(--fault)]')}
              empty={
                <span className="flex flex-col items-center gap-2">
                  No robots match these filters.
                  <Button size="sm" onClick={clearFilters}>Clear filters</Button>
                </span>
              }
              columns={columns}
            />
          </div>
          {robots.data && robots.data.total > 0 && <Pagination page={page} limit={LIMIT} total={robots.data.total} onPage={(p) => setParams({ page: p === 1 ? null : p })} />}
        </>
      )}
    </>
  );
}

/**
 * The fixed column set: only what an operator needs to spot a robot that is busy, unhealthy or silent.
 * Everything else (software, distance, recordings, registration…) lives on the robot's own page.
 */
function robotColumns(now: number): Column<RobotListItemDto>[] {
  return [
    {
      key: 'id',
      header: 'Robot',
      sortKey: 'robot_id',
      rowHeader: true,
      sticky: true,
      cell: (r) => (
        <span className="block min-w-40">
          <span className="flex items-center gap-2">
            <Link href={`/robots/${r.robot_id}`} className="font-mono font-semibold text-accent-text hover:underline" onClick={(e) => e.stopPropagation()}>
              {r.robot_id}
            </Link>
            {r.deleted_at && <Badge tone="fault">Deleted</Badge>}
          </span>
          <span className="block text-xs font-normal whitespace-nowrap text-muted">
            {r.product_name} · SN <span className="font-mono">{r.serial_number}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'last_seen_at',
      className: 'whitespace-nowrap',
      cell: (r) => (
        <span className="block">
          <RobotStatusBadge lastSeenAt={r.last_seen_at} />
          <span className="mt-0.5 block text-xs text-muted">
            <Activity r={r} now={now} />
          </span>
        </span>
      ),
    },
    { key: 'owner', header: 'Owner', cell: (r) => (r.owner_company ? <span className="block max-w-48 truncate" title={r.owner_company}>{r.owner_company}</span> : <Dash />) },
    {
      key: 'battery',
      header: 'Battery',
      sortKey: 'battery_pct',
      cell: (r) =>
        r.battery_pct === null ? (
          <Dash />
        ) : (
          <span className="flex w-28 items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <span
                className={cn('block h-full rounded-full', r.battery_pct < 20 ? 'bg-fault' : r.battery_pct < 40 ? 'bg-warn' : 'bg-ok')}
                style={{ width: `${Math.max(0, Math.min(100, r.battery_pct))}%` }}
              />
            </span>
            <span className="w-9 text-right text-xs font-medium tabular-nums">{fmtPct(r.battery_pct)}</span>
          </span>
        ),
    },
    { key: 'health', header: 'Health', cell: (r) => <HealthDots health={r.health} /> },
    {
      key: 'alerts',
      header: 'Alerts',
      sortKey: 'unacked_critical_events',
      className: 'whitespace-nowrap',
      cell: (r) =>
        r.unacked_critical_events ? (
          <Link href={`/robots/${r.robot_id}?tab=events`} onClick={(e) => e.stopPropagation()} aria-label={`${r.unacked_critical_events} unacknowledged critical alerts on ${r.robot_id}`}>
            <Badge tone="fault" icon={<AlertOctagon className="size-3.5" aria-hidden />}>
              {r.unacked_critical_events} critical
            </Badge>
          </Link>
        ) : (
          <Dash />
        ),
    },
    {
      key: 'missions',
      header: 'Missions',
      sortKey: 'total_missions',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (r) => (
        <span className="block">
          <span className="font-semibold tabular-nums">{r.total_missions}</span>
          {r.failed + r.aborted > 0 && (
            <span className="mt-0.5 block text-xs tabular-nums">
              {r.failed > 0 && <span className="text-fault">{r.failed} failed</span>}
              {r.failed > 0 && r.aborted > 0 && <span className="text-muted"> · </span>}
              {r.aborted > 0 && <span className="text-warn">{r.aborted} aborted</span>}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'data',
      header: 'Last data',
      sortKey: 'last_upload_at',
      className: 'whitespace-nowrap text-xs',
      cell: (r) => (r.last_upload_at ? <Ago iso={r.last_upload_at} now={now} /> : <span className="text-muted">None yet</span>),
    },
  ];
}

const Dash = () => <span className="text-muted">—</span>;

/** What the robot is doing right now; falls back to how long ago it was last heard from. */
function Activity({ r, now }: { r: RobotListItemDto; now: number }) {
  const heard = r.last_seen_at !== null && now - Date.parse(r.last_seen_at) < 120_000;
  if (heard && r.current_mission_id) {
    return (
      <Link
        href={`/robots/${r.robot_id}/missions/${encodeURIComponent(r.current_mission_id)}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-block max-w-44 truncate align-bottom text-accent-text hover:underline"
        title={`On mission ${r.current_mission_id}`}
      >
        On mission <span className="font-mono">{r.current_mission_id}</span>
      </Link>
    );
  }
  if (heard && r.recording) return <span className="text-accent-text">Recording</span>;
  return <LastSeen iso={r.last_seen_at} now={now} />;
}

function Ago({ iso, now }: { iso: string; now: number }) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const txt = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  return (
    <time dateTime={iso} title={new Date(iso).toISOString()}>
      {txt}
    </time>
  );
}

function LastSeen({ iso, now }: { iso: string | null; now: number }) {
  return iso ? <Ago iso={iso} now={now} /> : <span className="text-muted">never</span>;
}

/** Four dots (Controller, LiDAR, Cameras, GPS) plus a word: compact device health for the table. */
function HealthDots({ health }: { health: DeviceHealthDto }) {
  const bad = DEVICES.filter(([k]) => health[k] === 'fault' || health[k] === 'warning');
  const unknown = DEVICES.every(([k]) => !health[k]);
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" title={DEVICES.map(([k, n]) => `${n}: ${health[k] ?? 'not reported'}`).join('\n')}>
      {DEVICES.map(([k, n]) => (
        <span key={k} className={cn('size-2.5 rounded-full', health[k] ? HEALTH_DOT[health[k]!] : 'bg-border')} aria-hidden title={n} />
      ))}
      <span className={cn('ml-1 text-xs', bad.length ? 'font-medium text-fault' : 'text-muted')}>
        {unknown ? 'Not reported' : bad.length === 1 ? bad[0][1] : bad.length ? `${bad.length} issues` : 'All OK'}
      </span>
    </span>
  );
}

const DEVICES: [keyof DeviceHealthDto, string][] = [
  ['controller', 'Controller'],
  ['lidar', 'LiDAR'],
  ['cameras', 'Cameras'],
  ['gps', 'GPS'],
];
const HEALTH_DOT = { ok: 'bg-ok', warning: 'bg-warn', fault: 'bg-fault' } as const;
