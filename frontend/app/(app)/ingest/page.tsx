'use client';

import type { IngestLogItemDto, IngestRejectionDto, Paginated } from '@arnobot/message-schema';
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

const LIMIT = 50;

export default function IngestPage() {
  useDocumentTitle('Ingest');
  const can = useCan();
  const [params, setParams] = useUrlState();
  const tabs = [
    ...(can('ingest.read') ? [{ id: 'messages', label: 'Accepted messages' }, { id: 'rejections', label: 'Rejected messages' }] : []),
    ...(can('ingest.manage') ? [{ id: 'clients', label: 'Robot & GCS keys' }] : []),
  ];
  const requested = params.get('tab') ?? tabs[0]?.id;
  const tab = tabs.some((t) => t.id === requested) ? requested! : tabs[0]?.id;

  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Ingest"
        description="Messages pushed by robots and the GCS to the ingest service. Every message is stored exactly once (by msg_id); rejected input is kept for diagnosis."
      />
      {!tab ? (
        <InlineAlert tone="fault">You don&apos;t have permission to view the ingest log.</InlineAlert>
      ) : (
        <>
          <Tabs label="Ingest sections" items={tabs} value={tab} onChange={(id) => setParams({ tab: id, page: null })} />
          <TabPanel id={tab}>
            {tab === 'messages' && <MessagesTab />}
            {tab === 'rejections' && <RejectionsTab />}
            {tab === 'clients' && <IngestClientsPanel />}
          </TabPanel>
        </>
      )}
    </>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>;
}

function MessagesTab() {
  const [robot, setRobot] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['ingest', 'messages', { robot, type, page }],
    queryFn: () => api.get<Paginated<IngestLogItemDto>>('/ingest/messages', { robot, type, page, limit: LIMIT }),
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
        <EmptyState title="No messages yet" description="Start the simulator (npm run sim) or connect a robot / the GCS relay." />
      ) : (
        <>
          <DataTable
            caption="Accepted messages"
            dense
            rows={q.data?.items ?? []}
            rowKey={(m) => m.msg_id}
            onRowClick={(m) => setOpen(m.msg_id)}
            columns={[
              { key: 'rx', header: 'Received', rowHeader: true, cell: (m) => <Time iso={m.received_at} /> },
              { key: 'ts', header: 'Captured (ts)', cell: (m) => <Time iso={m.ts} /> },
              { key: 'r', header: 'Robot', cell: (m) => <Link href={`/robots/${m.robot_id}`} className="font-mono text-accent-text hover:underline" onClick={(e) => e.stopPropagation()}>{m.robot_id}</Link> },
              { key: 't', header: 'Type', cell: (m) => <Badge>{m.type}</Badge> },
              { key: 'v', header: 'v', align: 'right', cell: (m) => m.v },
              { key: 'tr', header: 'Transport', cell: (m) => m.transport.toUpperCase() },
              { key: 'c', header: 'Client', cell: (m) => m.client_name ?? '—' },
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

function RejectionsTab() {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<IngestRejectionDto | null>(null);
  const q = useQuery({
    queryKey: ['ingest', 'rejections', page],
    queryFn: () => api.get<Paginated<IngestRejectionDto>>('/ingest/rejections', { page, limit: LIMIT }),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Common causes: <Mono>clock_ahead</Mono>/<Mono>clock_unsynced</Mono> (robot or GCS clock not NTP-synced), <Mono>robot_not_allowed</Mono> (key used for another robot),
        <Mono>product_mismatch</Mono>, <Mono>unknown_robot</Mono>, invalid payload.
      </p>
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.items.length && page === 1 ? (
        <EmptyState title="No rejected messages" description="Everything received so far passed validation." />
      ) : (
        <>
          <DataTable
            caption="Rejected messages"
            dense
            rows={q.data?.items ?? []}
            rowKey={(r) => String(r.id)}
            onRowClick={setOpen}
            columns={[
              { key: 'rx', header: 'Received', rowHeader: true, cell: (r) => <Time iso={r.received_at} /> },
              { key: 'e', header: 'Error', cell: (r) => <Badge tone="fault">{r.error}</Badge> },
              { key: 'r', header: 'Robot', cell: (r) => (r.robot_id ? <Mono>{r.robot_id}</Mono> : '—') },
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
