'use client';

import type { DocumentDto, HardwareRevisionDto, Paginated, ProductDto, RobotListItemDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DataActivityBadge } from '@/components/archive/badges';
import { DocumentsPanel, type OwnerOption } from '@/components/domain/documents-panel';
import { RobotStatusBadge } from '@/components/domain/status';
import { Button, IconButton, LinkButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, Card, EmptyState, KeyValue, Mono, PageHeader, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDistance } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { usePartTypes } from '@/lib/queries';

type ProductDetail = ProductDto & { revisions: HardwareRevisionDto[] };
interface ComponentRow {
  part_type_key: string;
  slot: string;
  model: string;
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['product', id], queryFn: () => api.get<ProductDetail>(`/products/${id}`) });
  return <QueryView query={q}>{(p) => <ProductView p={p} />}</QueryView>;
}

function ProductView({ p }: { p: ProductDetail }) {
  useDocumentTitle(p.name);
  const can = useCan();
  const canWrite = can('catalog.write');
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [showDeletedRevs, setShowDeletedRevs] = useState(false);
  const [revDialog, setRevDialog] = useState<HardwareRevisionDto | 'new' | null>(null);
  const [deletingRev, setDeletingRev] = useState<HardwareRevisionDto | null>(null);
  const [deletingProduct, setDeletingProduct] = useState(false);

  const docs = useQuery({ queryKey: ['product', p.id, 'documents'], queryFn: () => api.get<DocumentDto[]>(`/products/${p.id}/documents`) });
  const revisions = p.revisions.filter((r) => showDeletedRevs || !r.deleted_at);
  const owners: OwnerOption[] = [
    { label: `${p.name} (all revisions)`, owner: { product_id: p.id } },
    ...p.revisions.filter((r) => !r.deleted_at).map((r) => ({ label: `${p.name} ${r.name}`, owner: { hardware_revision_id: r.id } })),
  ];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['product', p.id] });
    void qc.invalidateQueries({ queryKey: ['products'] });
  };
  const revDel = useMutation({
    mutationFn: (r: HardwareRevisionDto) => (r.deleted_at ? api.post(`/revisions/${r.id}/restore`) : api.del(`/revisions/${r.id}`)),
    onSuccess: (_x, r) => {
      toast.success(r.deleted_at ? 'Revision restored' : 'Revision deleted (restorable)');
      setDeletingRev(null);
      invalidate();
    },
    onError: toast.error,
  });
  const prodDel = useMutation({
    mutationFn: () => (p.deleted_at ? api.post(`/products/${p.id}/restore`) : api.del(`/products/${p.id}`)),
    onSuccess: () => {
      toast.success(p.deleted_at ? 'Product restored' : 'Product deleted (restorable)');
      setDeletingProduct(false);
      invalidate();
    },
    onError: toast.error,
  });

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
        <Link href="/products" className="hover:underline">
          Products
        </Link>{' '}
        / <span aria-current="page">{p.name}</span>
      </nav>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {p.name} {p.deleted_at && <Badge tone="fault">Deleted</Badge>}
          </span>
        }
        description={p.description ?? undefined}
        actions={
          canWrite ? (
            <>
              {!p.deleted_at && (
                <Button icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              <Button
                variant="ghost"
                icon={p.deleted_at ? <RotateCcw className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                onClick={() => (p.deleted_at ? prodDel.mutate() : setDeletingProduct(true))}
              >
                {p.deleted_at ? 'Restore' : 'Delete'}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-6">
        <Card title="Product">
          <KeyValue
            columns={3}
            items={[
              { label: 'Code (permanent)', value: <Mono>{p.code}</Mono> },
              { label: 'Robots', value: <Link href={`/robots?product=${p.code}`} className="text-accent-text hover:underline">{p.robot_count} robot(s)</Link> },
              { label: 'Next Robot ID', value: <Mono>{`${p.code}${String(p.next_running_number).padStart(2, '0')}`}</Mono> },
            ]}
          />
        </Card>

        <ProductRobots code={p.code} name={p.name} />

        <Card
          title="Hardware revisions"
          actions={
            <>
              <Checkbox label="Show deleted" checked={showDeletedRevs} onChange={(e) => setShowDeletedRevs(e.target.checked)} />
              {canWrite && !p.deleted_at && (
                <Button size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setRevDialog('new')}>
                  Add revision
                </Button>
              )}
            </>
          }
        >
          <p className="mb-3 text-sm text-muted">A revision names one set of main components. Create a new revision when a main component changes. Optional in v1.</p>
          {revisions.length === 0 ? (
            <EmptyState title="No revisions" description="Robots of this product can be registered without a revision." />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {revisions.map((r) => (
                <article key={r.id} className={`rounded-md border border-border p-4 ${r.deleted_at ? 'opacity-60' : ''}`} aria-labelledby={`rev-${r.id}`}>
                  <header className="mb-2 flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 id={`rev-${r.id}`} className="font-semibold">
                        {r.name} {r.deleted_at && <Badge tone="fault">Deleted</Badge>}
                      </h3>
                      {r.description && <p className="text-sm text-muted">{r.description}</p>}
                      <p className="text-xs text-muted">{r.robot_count} robot(s)</p>
                    </div>
                    {canWrite && (
                      <span className="flex gap-1">
                        {!r.deleted_at && (
                          <Button size="sm" variant="ghost" onClick={() => setRevDialog(r)} aria-label={`Edit ${r.name}`} icon={<Pencil className="size-3.5" aria-hidden />}>
                            Edit
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => (r.deleted_at ? revDel.mutate(r) : setDeletingRev(r))}
                          aria-label={r.deleted_at ? `Restore ${r.name}` : `Delete ${r.name}`}
                          icon={r.deleted_at ? <RotateCcw className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                        >
                          {r.deleted_at ? 'Restore' : 'Delete'}
                        </Button>
                      </span>
                    )}
                  </header>
                  {r.components.length === 0 ? (
                    <p className="text-sm text-muted">No main components listed.</p>
                  ) : (
                    <DataTable
                      caption={`Main components of ${r.name}`}
                      dense
                      rows={r.components}
                      rowKey={(c) => c.id}
                      columns={[
                        { key: 't', header: 'Part', rowHeader: true, cell: (c) => `${c.part_type_name}${c.slot ? ` ${c.slot}` : ''}` },
                        { key: 'm', header: 'Model', cell: (c) => c.model ?? '—' },
                      ]}
                    />
                  )}
                </article>
              ))}
            </div>
          )}
        </Card>

        <Card title="Documents">
          <QueryView query={docs}>
            {(list) => <DocumentsPanel documents={list} invalidateKey={['product', p.id, 'documents']} owners={p.deleted_at ? [] : owners} emptyText="No product or revision documents" />}
          </QueryView>
        </Card>
      </div>

      <EditProductDialog p={p} open={editing} onClose={() => setEditing(false)} />
      <RevisionDialog productId={p.id} value={revDialog} onClose={() => setRevDialog(null)} />
      <ConfirmDialog
        open={!!deletingRev}
        onClose={() => setDeletingRev(null)}
        onConfirm={() => deletingRev && revDel.mutate(deletingRev)}
        loading={revDel.isPending}
        danger
        title={`Delete ${deletingRev?.name ?? ''}?`}
        description="Hidden from new registrations; robots already on this revision keep it. Restorable."
        confirmLabel="Delete revision"
      />
      <ConfirmDialog
        open={deletingProduct}
        onClose={() => setDeletingProduct(false)}
        onConfirm={() => prodDel.mutate()}
        loading={prodDel.isPending}
        danger
        title={`Delete ${p.name}?`}
        description="No new robots can be registered for it. Existing robots and their IDs are unaffected. The code is never reused. Restorable."
        confirmLabel="Delete product"
      />
    </>
  );
}

/** The robots of this product: each has a permanent Robot ID (code + running number) and an 8-digit serial. */
function ProductRobots({ code, name }: { code: string; name: string }) {
  const router = useRouter();
  const can = useCan();
  const q = useQuery({
    queryKey: ['robots', 'product', code],
    queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { product: code, limit: 200, sort: 'robot_id' }),
  });
  return (
    <Card
      title={`${name} robots`}
      actions={
        can('robot.write') ? (
          <LinkButton href="/robots/new" size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />}>
            Register robot
          </LinkButton>
        ) : undefined
      }
    >
      <QueryView query={q}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title="No robots yet" description={`Register one to get ${code}01 and its serial number.`} />
          ) : (
            <>
            <ProductTotals robots={d.items} />
            <DataTable
              caption={`Robots of ${name}`}
              dense
              rows={d.items}
              rowKey={(r) => r.robot_id}
              onRowClick={(r) => router.push(`/robots/${r.robot_id}`)}
              columns={[
                {
                  key: 'id',
                  header: 'Robot ID',
                  rowHeader: true,
                  cell: (r) => (
                    <Link href={`/robots/${r.robot_id}`} onClick={(e) => e.stopPropagation()} className="font-mono font-semibold text-accent-text hover:underline">
                      {r.robot_id}
                    </Link>
                  ),
                },
                { key: 'serial', header: 'Serial number', cell: (r) => <Mono>{r.serial_number}</Mono> },
                { key: 'status', header: 'Status', cell: (r) => <RobotStatusBadge lastSeenAt={r.last_seen_at} /> },
                { key: 'missions', header: 'Missions', align: 'right', cell: (r) => r.total_missions },
                {
                  key: 'driven',
                  header: 'Total driven',
                  align: 'right',
                  cell: (r) => (r.odometer_m !== null ? fmtDistance(r.odometer_m) : <span className="text-muted" title="The robot does not report its odometer yet">—</span>),
                },
                { key: 'mdist', header: 'Mission distance', align: 'right', cell: (r) => fmtDistance(r.total_distance_m) },
                {
                  key: 'data',
                  header: 'Data',
                  cell: (r) => <DataActivityBadge lastSeenAt={r.last_seen_at} lastUploadAt={r.last_upload_at} sendingData={r.sending_data} recording={r.recording} />,
                },
                {
                  key: 'videos',
                  header: 'Videos',
                  align: 'right',
                  cell: (r) => (
                    <Link href={`/robots/${r.robot_id}?tab=videos`} onClick={(e) => e.stopPropagation()} className="text-accent-text hover:underline">
                      {r.video_sessions} recording(s)
                    </Link>
                  ),
                },
              ]}
            />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

function EditProductDialog({ p, open, onClose }: { p: ProductDetail; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description ?? '');
  const m = useMutation({
    mutationFn: () => api.patch<ProductDto>(`/products/${p.id}`, { name: name.trim(), description: description.trim() || null }),
    onSuccess: () => {
      toast.success('Product updated');
      void qc.invalidateQueries({ queryKey: ['product', p.id] });
      void qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Edit ${p.name}`}
      description={`The code "${p.code}" is permanent.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function RevisionDialog({ productId, value, onClose }: { productId: string; value: HardwareRevisionDto | 'new' | null; onClose: () => void }) {
  const existing = value && value !== 'new' ? value : null;
  const qc = useQueryClient();
  const toast = useToast();
  const types = usePartTypes();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<ComponentRow[]>([]);

  useEffect(() => {
    setName(existing?.name ?? '');
    setDescription(existing?.description ?? '');
    setRows(existing ? existing.components.map((c) => ({ part_type_key: c.part_type_key, slot: c.slot ? String(c.slot) : '', model: c.model ?? '' })) : [{ part_type_key: '', slot: '', model: '' }]);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const components = rows
    .filter((r) => r.part_type_key)
    .map((r) => ({ part_type_key: r.part_type_key, slot: r.slot ? Number(r.slot) : undefined, model: r.model.trim() || undefined }));

  const m = useMutation({
    mutationFn: async () => {
      if (existing) {
        if (name.trim() !== existing.name || (description.trim() || null) !== existing.description) {
          await api.patch(`/revisions/${existing.id}`, { name: name.trim(), description: description.trim() || null });
        }
        return api.put<HardwareRevisionDto>(`/revisions/${existing.id}/components`, { components });
      }
      return api.post<HardwareRevisionDto>(`/products/${productId}/revisions`, { name: name.trim(), description: description.trim() || undefined, components });
    },
    onSuccess: () => {
      toast.success(existing ? 'Revision updated' : 'Revision added');
      void qc.invalidateQueries({ queryKey: ['product', productId] });
      void qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
    },
    onError: toast.error,
  });

  const update = (i: number, patch: Partial<ComponentRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      size="lg"
      title={existing ? `Edit ${existing.name}` : 'Add hardware revision'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required hint="e.g. Rev A">
            <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Main components</legend>
          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <li key={i} className="grid grid-cols-[1fr_5rem_1fr_auto] items-end gap-2">
                <Field label={`Part ${i + 1}`}>
                  <Select value={r.part_type_key} onChange={(e) => update(i, { part_type_key: e.target.value })}>
                    <option value="">Choose…</option>
                    {types.data?.map((t) => (
                      <option key={t.id} value={t.key}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Slot">
                  <Input type="number" min={1} value={r.slot} onChange={(e) => update(i, { slot: e.target.value })} />
                </Field>
                <Field label="Model">
                  <Input value={r.model} onChange={(e) => update(i, { model: e.target.value })} />
                </Field>
                <IconButton label={`Remove part ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  <X className="size-4" aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
          <Button size="sm" className="mt-2" icon={<Plus className="size-4" aria-hidden />} onClick={() => setRows((rs) => [...rs, { part_type_key: '', slot: '', model: '' }])}>
            Add component
          </Button>
        </fieldset>
      </div>
    </Dialog>
  );
}

/** Totals of all robots of this product: robots, missions, total driven (odometers) and mission distance. */
function ProductTotals({ robots }: { robots: RobotListItemDto[] }) {
  const missions = robots.reduce((n, r) => n + r.total_missions, 0);
  const mission = robots.reduce((n, r) => n + r.total_distance_m, 0);
  const odo = robots.filter((r) => r.odometer_m !== null);
  const total = robots.reduce((n, r) => n + (r.odometer_m ?? r.total_distance_m), 0);
  const items: [string, string, string?][] = [
    ['Robots', String(robots.length)],
    ['Missions', missions.toLocaleString()],
    ['Total driven', fmtDistance(total), odo.length < robots.length ? `${odo.length} of ${robots.length} robots report an odometer` : 'All driving'],
    ['Mission distance', fmtDistance(mission), 'Driven on missions'],
  ];
  return (
    <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map(([label, value, sub]) => (
        <div key={label} className="rounded-lg bg-surface-2 px-3 py-2.5">
          <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
          {sub && <dd className="text-xs text-muted">{sub}</dd>}
        </div>
      ))}
    </dl>
  );
}
