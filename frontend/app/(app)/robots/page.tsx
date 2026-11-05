'use client';

import type { AttachmentDto, Paginated, ProductDto, RobotListItemDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { attachmentUnit, CategoryIcon, Thumb } from '@/components/domain/robot-build';
import { useSites } from '@/components/domain/sites';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { FilterChoice, FilterField, FilterMenu } from '@/components/ui/filter-menu';
import { Badge, EmptyState, ErrorState, LoadingBlock, Pagination } from '@/components/ui/misc';
import { DataTable, type Column, type SortState } from '@/components/ui/table';
import { api, downloadUrl, qs } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtSerial, fmtWhen } from '@/lib/format';
import { useDebounced, useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useCompanies } from '@/lib/queries';
import { useLivePoll } from '@/lib/realtime';

const LIMIT = 50;

/** Every robot: what it is and where it is. Search and Filter sit at the top right, so the table gets the room. */
export default function RobotsPage() {
  useDocumentTitle('Robots');
  const can = useCan();
  const router = useRouter();
  const poll = useLivePoll();
  const [params, setParams] = useUrlState();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search, 300);

  const product = params.get('product') ?? '';
  const category = params.get('category') === 'ugv' || params.get('category') === 'uav' ? params.get('category')! : '';
  const status = params.get('status') === 'online' || params.get('status') === 'offline' ? params.get('status')! : '';
  const owner = params.get('owner') ?? '';
  const attachment = params.get('attachment') ?? '';
  const site = params.get('site') ?? '';
  const includeDeleted = params.get('include_deleted') === 'true';
  const page = Number(params.get('page') ?? 1) || 1;
  const sortParam = params.get('sort') ?? 'robot_id';
  const sort: SortState = sortParam.startsWith('-') ? { key: sortParam.slice(1), dir: 'desc' } : { key: sortParam, dir: 'asc' };
  const activeFilters = [product, category, status, owner, attachment, site, includeDeleted].filter(Boolean).length;
  const filtered = Boolean(q) || activeFilters > 0;

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParams({ q, page: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const clearFilters = () => {
    setSearch('');
    setParams({ q: null, product: null, category: null, owner: null, attachment: null, site: null, status: null, include_deleted: null, page: null });
  };

  const products = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.get<ProductDto[]>('/products'), enabled: can('catalog.read'), staleTime: 300_000 });
  const robots = useQuery({
    queryKey: ['robots', { q, product, category, owner, attachment, site, status, includeDeleted, page, sortParam }],
    queryFn: () =>
      api.get<Paginated<RobotListItemDto>>('/robots', {
        q,
        product,
        category,
        owner,
        attachment: attachment || undefined,
        site: site || undefined,
        status,
        include_deleted: includeDeleted,
        sort: sortParam,
        page,
        limit: LIMIT,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: poll,
  });
  const companies = useCompanies();
  const attachments = useQuery({ queryKey: ['attachments'], queryFn: () => api.get<AttachmentDto[]>('/attachments'), enabled: can('catalog.read'), staleTime: 300_000 });
  const sites = useSites();
  const exportQuery = qs({ q, product, category, owner, attachment: attachment || undefined, site: site || undefined, status, include_deleted: includeDeleted || undefined, sort: sortParam });
  const pick = (patch: Record<string, string | null>) => setParams({ ...patch, page: null });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {status === 'online' ? 'Online robots' : status === 'offline' ? 'Offline robots' : 'Robots'}
          {robots.data && <span className="ml-2 text-base font-normal text-muted tabular-nums">{robots.data.total.toLocaleString('en-IN')}</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56 max-w-full" role="search">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search robots" aria-label="Search robots" className="pl-9" />
          </div>
          <FilterMenu count={activeFilters} onClear={activeFilters > 0 ? clearFilters : undefined}>
            <FilterChoice label="Status" value={status} onChange={(v) => pick({ status: v || null })} options={[['', 'All'], ['online', 'Online'], ['offline', 'Offline']]} />
            <FilterChoice label="Type" value={category} onChange={(v) => pick({ category: v || null, product: null })} options={[['', 'All'], ['ugv', 'UGV'], ['uav', 'UAV']]} />
            {can('catalog.read') && (
              <FilterField label="Base model">
                <Select value={product} onChange={(e) => pick({ product: e.target.value || null })}>
                  <option value="">All base models</option>
                  {products.data?.filter((p) => !category || p.category === category).map((p) => (
                    <option key={p.id} value={p.code}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </FilterField>
            )}
            {(attachments.data?.length ?? 0) > 0 && (
              <FilterField label="Attachment">
                <Select value={attachment} onChange={(e) => pick({ attachment: e.target.value || null })}>
                  <option value="">Any attachment</option>
                  {attachments.data?.filter((a) => !category || !a.category || a.category === category).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.robot_count})
                    </option>
                  ))}
                </Select>
              </FilterField>
            )}
            {(sites.data?.length ?? 0) > 0 && (
              <FilterField label="Deployed at">
                <Select value={site} onChange={(e) => pick({ site: e.target.value || null })}>
                  <option value="">All sites</option>
                  <option value="none">Not deployed</option>
                  {sites.data?.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name} ({st.robots_now})
                    </option>
                  ))}
                </Select>
              </FilterField>
            )}
            {(companies.data?.length ?? 0) > 1 && (
              <FilterField label="Owner">
                <Select value={owner} onChange={(e) => pick({ owner: e.target.value || null })}>
                  <option value="">All owners</option>
                  {companies.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FilterField>
            )}
            <FilterField label="Sort by">
              <Select value={sortParam} onChange={(e) => pick({ sort: e.target.value === 'robot_id' ? null : e.target.value })}>
                <option value="robot_id">Serial number</option>
                <option value="nickname">Name</option>
                <option value="-last_seen_at">Seen most recently</option>
                <option value="-created_at">Newest registered</option>
              </Select>
            </FilterField>
            <Checkbox label="Show deleted robots" checked={includeDeleted} onChange={(e) => pick({ include_deleted: e.target.checked ? 'true' : null })} />
          </FilterMenu>
          {can('robot.details') && (
            <a href={downloadUrl(`/robots/export.csv${exportQuery}`)} title="Export these robots as a CSV file" className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-3 text-base hover:bg-surface-2">
              <Download className="size-4" aria-hidden /> Export
            </a>
          )}
          {can('robot.write') && (
            <LinkButton href="/robots/new" variant="primary" icon={<Plus className="size-4" aria-hidden />}>
              Register robot
            </LinkButton>
          )}
        </div>
      </div>

      {robots.isLoading ? (
        <LoadingBlock rows={8} label="Loading robots" />
      ) : robots.error ? (
        <ErrorState error={robots.error} onRetry={() => void robots.refetch()} />
      ) : robots.data && robots.data.total === 0 && !filtered ? (
        <EmptyState title="No robots registered yet" description="Register a robot to get its permanent serial number." action={can('robot.write') ? <LinkButton href="/robots/new" variant="primary">Register robot</LinkButton> : undefined} />
      ) : (
        <>
          <div className={cn('transition-opacity [&_table]:text-xl [&_thead_th]:text-xl', robots.isPlaceholderData && 'opacity-60')} aria-busy={robots.isPlaceholderData}>
            <DataTable
              caption="Robots"
              rows={robots.data?.items ?? []}
              rowKey={(r) => r.robot_id}
              sort={sort}
              onSort={(s) => setParams({ sort: s.dir === 'desc' ? `-${s.key}` : s.key, page: null })}
              onRowClick={(r) => router.push(`/robots/${r.robot_id}`)}
              rowClassName={(r) => cn(r.deleted_at && 'opacity-60')}
              empty={
                <span className="flex flex-col items-center gap-2">
                  No robots match these filters.
                  <Button size="sm" onClick={clearFilters}>Clear filters</Button>
                </span>
              }
              columns={COLUMNS}
            />
          </div>
          {robots.data && robots.data.total > LIMIT && <Pagination page={page} limit={LIMIT} total={robots.data.total} onPage={(p) => setParams({ page: p === 1 ? null : p })} />}
        </>
      )}
    </>
  );
}

const Dash = () => <span className="text-muted">—</span>;

/** Only what identifies a robot: its picture, serial number, name, where it is deployed, base model and attachments. */
const COLUMNS: Column<RobotListItemDto>[] = [
  {
    key: 'picture',
    header: 'Picture',
    cell: (r) => <Thumb photoId={r.product_cover_photo_id} icon={<CategoryIcon category={r.category} className="size-10" />} className="h-36 w-40 object-contain!" />,
  },
  {
    key: 'robot_id',
    header: 'Serial number',
    sortKey: 'robot_id',
    rowHeader: true,
    cell: (r) => (
      <span className="block whitespace-nowrap">
        <Link href={`/robots/${r.robot_id}`} onClick={(e) => e.stopPropagation()} className="font-mono font-medium hover:underline">
          {fmtSerial(r.robot_id)}
        </Link>
        {r.deleted_at && (
          <span className="ml-2">
            <Badge tone="fault">Deleted</Badge>
          </span>
        )}
        {/* Phones have room for two columns: the name rides along here. */}
        {r.nickname && <span className="block truncate text-lg text-muted md:hidden">{r.nickname}</span>}
      </span>
    ),
  },
  {
    key: 'nickname',
    header: 'Name',
    sortKey: 'nickname',
    className: 'hidden md:table-cell',
    cell: (r) => (r.nickname ? <span className="font-medium">{r.nickname}</span> : <Dash />),
  },
  {
    key: 'deployed',
    header: 'Deployed',
    className: 'hidden lg:table-cell',
    cell: (r) =>
      r.site ? (
        <span className="block" title={`Since ${fmtWhen(r.site.deployed_since)}`}>
          {r.site.name}
          {r.site.city && <span className="block text-lg text-muted">{r.site.city}</span>}
        </span>
      ) : (
        <span className="text-muted">Not deployed</span>
      ),
  },
  {
    key: 'base_model',
    header: 'Base model',
    className: 'hidden md:table-cell',
    cell: (r) => (
      <span className="block whitespace-nowrap">
        {r.product_name}
        <span className="block text-lg text-muted">
          {r.category.toUpperCase()}
          {r.hardware_revision && ` · ${r.hardware_revision}`}
        </span>
      </span>
    ),
  },
  {
    key: 'attachments',
    header: 'Attachment',
    className: 'hidden lg:table-cell',
    cell: (r) =>
      r.attachments.length ? (
        <span title={r.attachments.map((x) => `${x.name}${attachmentUnit(x) ? ` (${attachmentUnit(x)})` : ''}`).join('\n')}>{r.attachments.map((x) => x.name).join(', ')}</span>
      ) : (
        <span className="text-muted">None</span>
      ),
  },
];
