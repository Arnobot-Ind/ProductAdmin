'use client';

import type { ReleaseDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { Badge, CopyButton, EmptyState, Mono, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, downloadUrl } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtBytes } from '@/lib/format';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useProducts } from '@/lib/queries';
import { SourceLink } from '@/components/domain/source-link';
import { RegisterReleaseDialog } from '@/components/domain/release-dialog';
import { RELEASE_COMPONENTS } from '@/lib/schema';

const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Spec §9: one release record per software / firmware version; every version is kept. */
export default function ReleasesPage() {
  useDocumentTitle('Releases');
  const can = useCan();
  const [params, setParams] = useUrlState();
  const productId = params.get('product_id') ?? '';
  const component = params.get('component') ?? '';
  const includeDeleted = params.get('include_deleted') === 'true';
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ReleaseDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const products = useProducts();
  const q = useQuery({
    queryKey: ['releases', { productId, component, includeDeleted }],
    queryFn: () => api.get<ReleaseDto[]>('/releases', { product_id: productId, component, include_deleted: includeDeleted }),
  });
  const del = useMutation({
    mutationFn: (r: ReleaseDto) => (r.deleted_at ? api.post(`/releases/${r.id}/restore`) : api.del(`/releases/${r.id}`)),
    onSuccess: (_x, r) => {
      toast.success(r.deleted_at ? 'Release restored' : 'Release deleted (restorable; the version number stays used)');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['releases'] });
    },
    onError: toast.error,
  });

  return (
    <>
      <PageHeader
        eyebrow="Hardware & software"
        title="Software & firmware releases"
        description="Software (navigation, cameras, maps) and firmware (motors, battery, sensors) are versioned separately. Each package carries a SHA-256 checksum and an Arnobot signature; the robot refuses a package that fails either check."
        actions={
          can('release.write') ? (
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
              Register release
            </Button>
          ) : undefined
        }
      />
      <form aria-label="Filter releases" className="mb-4 grid gap-3 sm:grid-cols-3 sm:items-end" onSubmit={(e) => e.preventDefault()}>
        <Field label="Base model">
          <Select value={productId} onChange={(e) => setParams({ product_id: e.target.value })}>
            <option value="">All base models</option>
            {products.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Component">
          <Select value={component} onChange={(e) => setParams({ component: e.target.value })}>
            <option value="">Software and firmware</option>
            {RELEASE_COMPONENTS.map((c) => (
              <option key={c} value={c}>
                {capital(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setParams({ include_deleted: e.target.checked ? 'true' : null })} className="h-10" />
      </form>
      <QueryView query={q}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No releases registered" description="Register each software or firmware version with its update package, checksum and signature." />
          ) : (
            <DataTable
              caption="Releases"
              rows={rows}
              rowKey={(r) => r.id}
              rowClassName={(r) => (r.deleted_at ? 'opacity-60' : undefined)}
              columns={[
                { key: 'p', header: 'Product', rowHeader: true, cell: (r) => <Mono>{r.product_code}</Mono> },
                { key: 'c', header: 'Component', cell: (r) => <Badge tone={r.component === 'software' ? 'accent' : 'neutral'}>{capital(r.component)}</Badge> },
                {
                  key: 'v',
                  header: 'Version',
                  cell: (r) => (
                    <span>
                      <Mono>{r.version}</Mono>
                      {r.deleted_at && <Badge tone="fault" className="ml-2">Deleted</Badge>}
                    </span>
                  ),
                },
                { key: 'src', header: 'Source', cell: (r) => <SourceLink repo={r.repo_url} commit={r.commit_id} /> },
                { key: 'req', header: 'Requires', cell: (r) => (r.requires_component ? `${r.requires_component} ≥ ${r.requires_min_version}` : '—') },
                {
                  key: 'sha',
                  header: 'SHA-256',
                  cell: (r) => (
                    <span className="flex items-center gap-2">
                      <code className="font-mono text-xs" title={r.sha256}>
                        {r.sha256.slice(0, 12)}…
                      </code>
                      <CopyButton value={r.sha256} label="Copy" />
                    </span>
                  ),
                },
                { key: 'sig', header: 'Signature', cell: (r) => <code className="font-mono text-xs" title={r.signature}>{r.signature_algo ? `${r.signature_algo}: ` : ''}{r.signature.slice(0, 12)}…</code> },
                {
                  key: 'f',
                  header: 'Package',
                  cell: (r) =>
                    r.file ? (
                      <a href={downloadUrl(`/releases/${r.id}/download`)} className="inline-flex items-center gap-1 text-accent-text hover:underline">
                        <Download className="size-4" aria-hidden /> {r.file.filename} ({fmtBytes(r.file.size_bytes)})
                      </a>
                    ) : (
                      <span className="text-muted">No file</span>
                    ),
                },
                { key: 'at', header: 'Registered', cell: (r) => <span className="text-xs"><Time iso={r.created_at} /><br />{r.created_by_name ?? '—'}</span> },
                {
                  key: 'act',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  cell: (r) =>
                    can('release.write') ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={r.deleted_at ? <RotateCcw className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                        onClick={() => (r.deleted_at ? del.mutate(r) : setDeleting(r))}
                        aria-label={`${r.deleted_at ? 'Restore' : 'Delete'} ${r.product_code} ${r.component} ${r.version}`}
                      >
                        {r.deleted_at ? 'Restore' : 'Delete'}
                      </Button>
                    ) : null,
                },
              ]}
            />
          )
        }
      </QueryView>
      {adding && <RegisterReleaseDialog onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        loading={del.isPending}
        danger
        title="Delete release?"
        description="The record is hidden and restorable; the package stays in S3 and the version number is never reused."
        confirmLabel="Delete"
      />
    </>
  );
}
