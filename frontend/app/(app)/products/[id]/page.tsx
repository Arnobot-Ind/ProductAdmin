'use client';

import { RobotRef } from '@/components/domain/robot-ref';

import type { DocumentDto, HardwareRevisionDto, Paginated, ProductDto, RobotCategory, RobotListItemDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { DataActivityBadge } from '@/components/archive/badges';
import { DocumentsPanel, type OwnerOption } from '@/components/domain/documents-panel';
import { CategoryBadge, RobotStatusBadge } from '@/components/domain/status';
import { CategoryPicker } from '@/components/domain/category-picker';
import { ProductMediaCard } from '@/components/domain/product-media';
import { RevisionsCard } from '@/components/domain/hardware-revisions';
import { ROBOT_CATEGORY_LABEL } from '@/lib/schema';
import { Button, LinkButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Badge, Card, EmptyState, KeyValue, Mono, PageHeader, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDistance } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';
import { BesideBack } from '@/components/ui/back-button';

type ProductDetail = ProductDto & { revisions: HardwareRevisionDto[] };

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
  const [deletingProduct, setDeletingProduct] = useState(false);

  const docs = useQuery({ queryKey: ['product', p.id, 'documents'], queryFn: () => api.get<DocumentDto[]>(`/products/${p.id}/documents`) });
  const owners: OwnerOption[] = [
    { label: `${p.name} (all revisions)`, owner: { product_id: p.id } },
    ...p.revisions.filter((r) => !r.deleted_at).map((r) => ({ label: `${p.name} ${r.name}`, owner: { hardware_revision_id: r.id } })),
  ];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['product', p.id] });
    void qc.invalidateQueries({ queryKey: ['products'] });
  };
  const prodDel = useMutation({
    mutationFn: () => (p.deleted_at ? api.post(`/products/${p.id}/restore`) : api.del(`/products/${p.id}`)),
    onSuccess: () => {
      toast.success(p.deleted_at ? 'Base model restored' : 'Base model deleted (restorable)');
      setDeletingProduct(false);
      invalidate();
    },
    onError: toast.error,
  });

  return (
    <>
      <BesideBack>
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
          <Link href="/products" className="hover:underline">
            Base models
          </Link>{' '}
          / <span aria-current="page">{p.name}</span>
        </nav>
      </BesideBack>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {p.name} <CategoryBadge category={p.category} /> {p.deleted_at && <Badge tone="fault">Deleted</Badge>}
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
        <Card title="Base model">
          <KeyValue
            columns={3}
            items={[
              { label: 'Category', value: `${ROBOT_CATEGORY_LABEL[p.category]} · ${p.category === 'uav' ? 'aerial robot' : 'ground robot'}` },
              { label: 'Code (permanent)', value: <Mono>{p.code}</Mono> },
              {
                label: 'Software repository',
                value: p.repo_url ? (
                  <a href={p.repo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-accent-text hover:underline">
                    {p.repo_url} <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                  </a>
                ) : null,
              },
              { label: 'Robots', value: <Link href={`/robots?product=${p.code}`} className="text-accent-text hover:underline">{p.robot_count} robot(s)</Link> },
              { label: 'Next Robot ID', value: <Mono>{`${p.code}${String(p.next_running_number).padStart(2, '0')}`}</Mono> },
            ]}
          />
        </Card>

        <ProductMediaCard productId={p.id} name={p.name} />

        <ProductRobots code={p.code} name={p.name} />

        <RevisionsCard owner="products" ownerId={p.id} revisions={p.revisions} readOnly={!!p.deleted_at} />

        <Card title="Documents">
          <QueryView query={docs}>
            {(list) => <DocumentsPanel documents={list} invalidateKey={['product', p.id, 'documents']} owners={p.deleted_at ? [] : owners} emptyText="No base model or revision documents" />}
          </QueryView>
        </Card>
      </div>

      <EditProductDialog p={p} open={editing} onClose={() => setEditing(false)} />
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
                    <RobotRef id={r.robot_id} onClick={(e) => e.stopPropagation()} />
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
  const [category, setCategory] = useState<RobotCategory>(p.category);
  const [repo, setRepo] = useState(p.repo_url ?? '');
  const repoBad = !!repo.trim() && !/^https?:\/\/\S+$/i.test(repo.trim());
  const m = useMutation({
    mutationFn: () => api.patch<ProductDto>(`/products/${p.id}`, { name: name.trim(), description: description.trim() || null, category, repo_url: repo.trim() || null }),
    onSuccess: () => {
      toast.success('Base model updated');
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
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim() || repoBad}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field label="Category" required hint="Every robot of this base model shows this category.">
          <CategoryPicker value={category} onChange={setCategory} />
        </Field>
        <Field label="Description" hint="Shown on the page of every robot of this base model (unless the robot has its own description).">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Software repository" hint="GitHub (or other) link, e.g. https://github.com/arnobot/saibya" error={repoBad ? 'A web link starting with https://' : null}>
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/…" spellCheck={false} />
        </Field>
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
          <dt className="text-sm font-medium text-muted">{label}</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
          {sub && <dd className="text-xs text-muted">{sub}</dd>}
        </div>
      ))}
    </dl>
  );
}
