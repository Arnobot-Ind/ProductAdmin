'use client';

import { SourceLink } from '@/components/domain/source-link';
import { KIND_LABELS, ProductDialog } from '@/components/domain/software';
import type { SoftwareProductDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { Badge, EmptyState, InlineAlert, Mono, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';


/** The Arnobot software clients can run. Each client's installs and licences are on its organization page. */
export default function SoftwarePage() {
  useDocumentTitle('Software');
  const can = useCan();
  const router = useRouter();
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
              onRowClick={(p) => router.push(`/admin/software/${p.id}`)}
              columns={[
                {
                  key: 'n',
                  header: 'Software',
                  rowHeader: true,
                  cell: (p) => (
                    <span>
                      <Link href={`/admin/software/${p.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-accent-text hover:underline">
                        {p.name}
                      </Link>
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
