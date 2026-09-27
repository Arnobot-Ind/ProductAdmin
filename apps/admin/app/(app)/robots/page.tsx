'use client';

import type { Paginated, ProductDto, RobotListItemDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { HealthChips, RobotStatusBadge } from '@/components/domain/status';
import { LinkButton } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Badge, EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from '@/components/ui/misc';
import { DataTable, type SortState } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDistance, fmtDuration, fmtPct } from '@/lib/format';
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

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParams({ q, page: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

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

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Robots"
        description="One row per robot. Mission totals are calculated from the missions reported by robots and the GCS."
        actions={can('robot.write') ? <LinkButton href="/robots/new" variant="primary" icon={<Plus className="size-4" aria-hidden />}>Register robot</LinkButton> : undefined}
      />

      <form role="search" aria-label="Filter robots" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_auto] lg:items-end" onSubmit={(e) => e.preventDefault()}>
        <Field label="Search">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Robot ID or serial number" className="pl-9" type="search" />
          </div>
        </Field>
        <Field label="Product">
          <Select value={product} onChange={(e) => setParams({ product: e.target.value, page: null })}>
            <option value="">All products</option>
            {products.data?.map((p) => (
              <option key={p.id} value={p.code}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setParams({ status: e.target.value, page: null })}>
            <option value="">Any status</option>
            <option value="online">Online</option>
            <option value="stale">Stale</option>
            <option value="offline">Offline</option>
          </Select>
        </Field>
        <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setParams({ include_deleted: e.target.checked ? 'true' : null, page: null })} className="h-10" />
      </form>

      {robots.isLoading ? (
        <LoadingBlock rows={6} label="Loading robots" />
      ) : robots.error ? (
        <ErrorState error={robots.error} onRetry={() => void robots.refetch()} />
      ) : robots.data && robots.data.total === 0 && !q && !product && !status ? (
        <EmptyState
          title="No robots registered yet"
          description="Register a robot to get its permanent Robot ID and ingest key. Until real robots are online, run the simulator (npm run sim)."
          action={can('robot.write') ? <LinkButton href="/robots/new" variant="primary">Register robot</LinkButton> : undefined}
        />
      ) : (
        <>
          <DataTable
            caption="Robot summary"
            rows={robots.data?.items ?? []}
            rowKey={(r) => r.robot_id}
            sort={sort}
            onSort={(s) => setParams({ sort: s.dir === 'desc' ? `-${s.key}` : s.key, page: null })}
            onRowClick={(r) => router.push(`/robots/${r.robot_id}`)}
            rowClassName={(r) => (r.deleted_at ? 'opacity-60' : undefined)}
            empty="No robots match these filters."
            columns={[
              {
                key: 'id',
                header: 'Robot ID',
                sortKey: 'robot_id',
                rowHeader: true,
                cell: (r) => (
                  <span className="flex items-center gap-2">
                    <Link href={`/robots/${r.robot_id}`} className="font-mono font-semibold text-accent-text hover:underline" onClick={(e) => e.stopPropagation()}>
                      {r.robot_id}
                    </Link>
                    {r.deleted_at && <Badge tone="fault">Deleted</Badge>}
                  </span>
                ),
              },
              { key: 'product', header: 'Product', sortKey: 'product', cell: (r) => r.product_name },
              { key: 'serial', header: 'Serial', cell: (r) => <span className="font-mono text-xs">{r.serial_number}</span> },
              { key: 'status', header: 'Status', sortKey: 'last_seen_at', cell: (r) => <RobotStatusBadge lastSeenAt={r.last_seen_at} /> },
              {
                key: 'seen',
                header: 'Last seen',
                cell: (r) => <LastSeen iso={r.last_seen_at} now={now} />,
              },
              { key: 'battery', header: 'Battery', sortKey: 'battery_pct', align: 'right', cell: (r) => fmtPct(r.battery_pct) },
              { key: 'health', header: 'Health', cell: (r) => <HealthChips health={r.health} compact /> },
              { key: 'missions', header: 'Missions', sortKey: 'total_missions', align: 'right', cell: (r) => r.total_missions },
              {
                key: 'cfa',
                header: <abbr title="Completed / failed / aborted" className="no-underline">C / F / A</abbr>,
                align: 'right',
                cell: (r) => (
                  <span className="tabular-nums" aria-label={`${r.completed} completed, ${r.failed} failed, ${r.aborted} aborted`}>
                    <span className="text-ok">{r.completed}</span> / <span className="text-fault">{r.failed}</span> / <span className="text-warn">{r.aborted}</span>
                  </span>
                ),
              },
              { key: 'dist', header: 'Distance', sortKey: 'total_distance_m', align: 'right', cell: (r) => fmtDistance(r.total_distance_m) },
              { key: 'dur', header: 'Total time', sortKey: 'total_duration_s', align: 'right', cell: (r) => fmtDuration(r.total_duration_s) },
              { key: 'avg', header: 'Avg mission', align: 'right', cell: (r) => fmtDuration(r.avg_duration_s) },
            ]}
          />
          {robots.data && <Pagination page={page} limit={LIMIT} total={robots.data.total} onPage={(p) => setParams({ page: p })} />}
        </>
      )}
    </>
  );
}

function LastSeen({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="text-muted">never</span>;
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const txt = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  return (
    <time dateTime={iso} title={new Date(iso).toISOString()}>
      {txt}
    </time>
  );
}
