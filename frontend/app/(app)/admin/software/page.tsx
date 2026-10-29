'use client';

import { isCommitId, SourceLink } from '@/components/domain/source-link';
import type { SoftwareKind, SoftwareProductDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, EmptyState, InlineAlert, Mono, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';
import { SOFTWARE_KINDS } from '@/lib/schema';

const KIND_LABELS: Record<SoftwareKind, string> = {
  desktop_app: 'Desktop app',
  web_app: 'Web app',
  robot_software: 'Robot software',
  firmware: 'Firmware',
  service: 'Service',
};

/** The Arnobot software clients can run. Each client's installs and licences are on its organization page. */
export default function SoftwarePage() {
  useDocumentTitle('Software');
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<SoftwareProductDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SoftwareProductDto | null>(null);
  const q = useQuery({
    queryKey: ['software-products', includeDeleted],
    queryFn: () => api.get<SoftwareProductDto[]>('/software-products', { include_deleted: includeDeleted }),
    enabled: can('org.manage'),
  });
  const del = useMutation({
    mutationFn: (p: SoftwareProductDto) => (p.deleted_at ? api.post(`/software-products/${p.id}/restore`) : api.del(`/software-products/${p.id}`)),
    onSuccess: (_x, p) => {
      toast.success(p.deleted_at ? `${p.name} restored` : `${p.name} deleted`);
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['software-products'] });
    },
    onError: toast.error,
  });

  if (!can('org.manage')) {
    return (
      <>
        <PageHeader title="Software" />
        <InlineAlert tone="fault">You don&apos;t have permission to manage the software catalogue.</InlineAlert>
      </>
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="Hardware & software"
        title="Software"
        description="Arnobot software that clients run (GCS, client portal, robot software). Record each client's installs, versions and licences on its organization page."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
            New software
          </Button>
        }
      />
      <div className="mb-3">
        <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
      </div>
      <QueryView query={q}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No software" icon={<AppWindow className="size-8" />} />
          ) : (
            <DataTable
              caption="Software catalogue"
              rows={list}
              rowKey={(p) => p.id}
              rowClassName={(p) => (p.deleted_at ? 'opacity-60' : undefined)}
              columns={[
                {
                  key: 'n',
                  header: 'Software',
                  rowHeader: true,
                  cell: (p) => (
                    <span>
                      <span className="font-semibold">{p.name}</span>
                      {p.description && <span className="block text-xs text-muted">{p.description}</span>}
                    </span>
                  ),
                },
                { key: 'c', header: 'Code', cell: (p) => <Mono>{p.code}</Mono> },
                { key: 'k', header: 'Kind', cell: (p) => (p.deleted_at ? <Badge tone="fault">Deleted</Badge> : <Badge>{KIND_LABELS[p.kind]}</Badge>) },
                { key: 'v', header: 'Latest version', cell: (p) => (p.latest_version ? <span className="font-mono">{p.latest_version}</span> : <span className="text-muted">—</span>) },
                { key: 'src', header: 'Source', cell: (p) => <SourceLink repo={p.repo_url} commit={p.commit_id} /> },
                { key: 'i', header: 'Installs', align: 'right', cell: (p) => p.install_count },
                { key: 't', header: 'Added', cell: (p) => <Time iso={p.created_at} /> },
                {
                  key: 'a',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  cell: (p) => (
                    <span className="flex justify-end gap-1">
                      {!p.deleted_at && (
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                          Edit
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={p.deleted_at ? <RotateCcw className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                        onClick={() => (p.deleted_at ? del.mutate(p) : setDeleting(p))}
                        aria-label={`${p.deleted_at ? 'Restore' : 'Delete'} ${p.name}`}
                      >
                        {p.deleted_at ? 'Restore' : 'Delete'}
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          )
        }
      </QueryView>
      {editing && <ProductDialog product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        loading={del.isPending}
        danger
        title={`Delete ${deleting?.name ?? ''}?`}
        description="Only possible while no client has it installed. Restorable; its code is never reused."
        confirmLabel="Delete software"
      />
    </>
  );
}

function ProductDialog({ product, onClose }: { product: SoftwareProductDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    code: product?.code ?? '',
    name: product?.name ?? '',
    kind: product?.kind ?? ('desktop_app' as SoftwareKind),
    description: product?.description ?? '',
    latest_version: product?.latest_version ?? '',
    repo_url: product?.repo_url ?? '',
    commit_id: product?.commit_id ?? '',
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        kind: f.kind,
        description: f.description.trim() || null,
        latest_version: f.latest_version.trim() || null,
        repo_url: f.repo_url.trim() || null,
        commit_id: f.commit_id.trim() || null,
      };
      return product ? api.patch<SoftwareProductDto>(`/software-products/${product.id}`, body) : api.post<SoftwareProductDto>('/software-products', { ...body, code: f.code.trim() });
    },
    onSuccess: (p) => {
      toast.success(product ? `${p.name} updated` : `${p.name} added`);
      void qc.invalidateQueries({ queryKey: ['software-products'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      onClose();
    },
    onError: toast.error,
  });
  const codeBad = !product && !!f.code && !/^[a-z][a-z0-9_]*$/.test(f.code.trim());
  const repoBad = !!f.repo_url.trim() && !/^https?:\/\/\S+$/i.test(f.repo_url.trim());
  const commitBad = !!f.commit_id.trim() && !isCommitId(f.commit_id.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={product ? `Edit ${product.name}` : 'New software'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!f.name.trim() || (!product && !f.code.trim()) || codeBad || repoBad || commitBad}>
            {product ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Name" required>
          <Input value={f.name} onChange={(e) => set({ name: e.target.value })} data-autofocus />
        </Field>
        <Field
          label="Code"
          required={!product}
          hint={product ? 'Codes never change.' : 'Lowercase letters, digits and _. Cannot be changed or reused later.'}
          error={codeBad ? 'Lowercase letters, digits and _, starting with a letter' : null}
        >
          <Input value={f.code} onChange={(e) => set({ code: e.target.value })} className="font-mono" disabled={!!product} placeholder="gcs_desktop" />
        </Field>
        <Field label="Kind" required>
          <Select value={f.kind} onChange={(e) => set({ kind: e.target.value as SoftwareKind })}>
            {SOFTWARE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Latest version" hint="Installs on an older version show “update available”.">
          <Input value={f.latest_version} onChange={(e) => set({ latest_version: e.target.value })} className="font-mono" placeholder="1.0.0" />
        </Field>
        <Field label="GitHub link" hint="Optional: repository or release page of the latest version" error={repoBad ? 'A web link starting with https://' : null}>
          <Input value={f.repo_url} onChange={(e) => set({ repo_url: e.target.value })} placeholder="https://github.com/…" spellCheck={false} />
        </Field>
        <Field label="Commit ID" hint="Optional, of the latest version" error={commitBad ? '7–64 letters a–f and digits' : null}>
          <Input value={f.commit_id} onChange={(e) => set({ commit_id: e.target.value })} className="font-mono" spellCheck={false} placeholder="3f9c2ab" />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </form>
    </Dialog>
  );
}
