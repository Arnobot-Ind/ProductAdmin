'use client';

import type { ArchiveReindexDto, ArchiveSessionListDto, Paginated, ProductDto, RobotListItemDto } from '@arnobot/message-schema';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Search, Video } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SessionsTable } from '@/components/archive/sessions-table';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Pagination } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtBytes } from '@/lib/format';
import { useDebounced, useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

const LIMIT = 25;

export default function VideosPage() {
  useDocumentTitle('Videos');
  const can = useCan();
  const poll = useLivePoll();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useUrlState();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search, 300);
  const product = params.get('product') ?? '';
  const robot = params.get('robot') ?? '';
  const status = params.get('status') ?? '';
  const includeSim = params.get('include_sim') === 'true';
  const page = Number(params.get('page') ?? 1) || 1;

  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParams({ q, page: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const products = useQuery({ queryKey: ['products', 'all'], queryFn: () => api.get<ProductDto[]>('/products'), enabled: can('catalog.read'), staleTime: 300_000 });
  const robots = useQuery({
    queryKey: ['robots', 'options', product],
    queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { product, limit: 200 }),
    staleTime: 60_000,
  });
  const sessions = useQuery({
    queryKey: ['archive', 'sessions', { q, product, robot, status, includeSim, page }],
    queryFn: () => api.get<ArchiveSessionListDto>('/archive/sessions', { q, product, robot, status, include_sim: includeSim, page, limit: LIMIT }),
    placeholderData: keepPreviousData,
    refetchInterval: poll === false ? 60_000 : poll,
  });
  const reindex = useMutation({
    mutationFn: () => api.post<ArchiveReindexDto>('/archive/reindex', {}),
    onSuccess: (r) => {
      const files = r.robots.reduce((n, x) => n + x.files, 0);
      const found = r.robots.reduce((n, x) => n + x.sessions, 0);
      toast.success(`Re-index done: ${found} session(s), ${files} file(s) indexed${r.ignored_prefixes.length ? `. Not registered, ignored: ${r.ignored_prefixes.join(', ')}` : ''}`);
      void qc.invalidateQueries({ queryKey: ['archive'] });
    },
    onError: toast.error,
  });

  const filtered = Boolean(q || product || robot || status);
  const totals = sessions.data?.totals;

  return (
    <>
      <PageHeader
        eyebrow="Fleet"
        title="Videos"
        description="Camera recordings and sensor data uploaded by the robots, grouped per session (operator Start → Stop). Only robots registered here are shown. Open a recording to play all cameras in sync or download them."
        actions={
          can('ingest.manage') ? (
            <Button icon={<RefreshCw className="size-4" aria-hidden />} loading={reindex.isPending} onClick={() => reindex.mutate()} title="Rebuild the index from the archive store (use after robots uploaded while the server was unreachable)">
              Re-index storage
            </Button>
          ) : undefined
        }
      />

      {totals && (
        <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={filtered ? 'Matching recordings' : 'Recordings'} value={totals.sessions.toLocaleString()} />
          <Stat label="Recording now" value={totals.active.toLocaleString()} tone={totals.active ? 'ok' : undefined} />
          <Stat label="Video stored" value={fmtBytes(totals.video_bytes)} />
          <Stat label="Total stored" value={fmtBytes(totals.bytes)} />
        </dl>
      )}

      <form role="search" aria-label="Filter recordings" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_auto] lg:items-end" onSubmit={(e) => e.preventDefault()}>
        <Field label="Search">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Session, trip, robot ID or serial" className="pl-9" type="search" />
          </div>
        </Field>
        <Field label="Product">
          <Select value={product} onChange={(e) => setParams({ product: e.target.value, robot: null, page: null })}>
            <option value="">All products</option>
            {products.data?.map((p) => (
              <option key={p.id} value={p.code}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Robot">
          <Select value={robot} onChange={(e) => setParams({ robot: e.target.value, page: null })}>
            <option value="">All robots</option>
            {robots.data?.items.map((r) => (
              <option key={r.robot_id} value={r.robot_id}>
                {r.robot_id} · {r.serial_number}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setParams({ status: e.target.value, page: null })}>
            <option value="">Any status</option>
            <option value="active">Recording now</option>
            <option value="closed">Closed</option>
            <option value="interrupted">Interrupted</option>
          </Select>
        </Field>
        <Checkbox label="Bench simulations" checked={includeSim} onChange={(e) => setParams({ include_sim: e.target.checked ? 'true' : null, page: null })} className="h-10" />
      </form>

      {sessions.isLoading ? (
        <LoadingBlock rows={6} label="Loading recordings" />
      ) : sessions.error ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : sessions.data && sessions.data.total === 0 && !filtered ? (
        <EmptyState
          icon={<Video className="size-8" />}
          title="No recordings yet"
          description="Robots upload camera segments with their ingest key (PUT /api/v1/archive/upload). To try it locally, run npm run archive:sim in backend/."
        />
      ) : (
        <>
          <SessionsTable sessions={sessions.data?.items ?? []} showRobot caption="Recordings" empty="No recordings match these filters." />
          {sessions.data && <Pagination page={page} limit={LIMIT} total={sessions.data.total} onPage={(p) => setParams({ page: p })} />}
        </>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
      <dd className={`mt-1 font-display text-xl font-bold ${tone === 'ok' ? 'text-ok' : ''}`}>{value}</dd>
    </div>
  );
}
