'use client';

import type { ReleaseComponent, ReleaseDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, CopyButton, EmptyState, InlineAlert, Mono, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, downloadUrl, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtBytes } from '@/lib/format';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useProducts } from '@/lib/queries';
import { RELEASE_COMPONENTS } from '@/lib/schema';

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/;
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
        eyebrow="Catalogue"
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
        <Field label="Product">
          <Select value={productId} onChange={(e) => setParams({ product_id: e.target.value })}>
            <option value="">All products</option>
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
      <RegisterReleaseDialog open={adding} onClose={() => setAdding(false)} />
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

function RegisterReleaseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const products = useProducts(open);
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ product_id: '', component: 'software' as ReleaseComponent, version: '', signature: '', signature_algo: 'ed25519', sha256: '', requires_min_version: '', notes: '' });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const other: ReleaseComponent = f.component === 'software' ? 'firmware' : 'software';

  const m = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('product_id', f.product_id);
      fd.set('component', f.component);
      fd.set('version', f.version.trim());
      fd.set('signature', f.signature.trim());
      if (f.signature_algo.trim()) fd.set('signature_algo', f.signature_algo.trim());
      if (f.sha256.trim()) fd.set('sha256', f.sha256.trim().toLowerCase());
      if (f.requires_min_version.trim()) {
        fd.set('requires_component', other);
        fd.set('requires_min_version', f.requires_min_version.trim());
      }
      if (f.notes.trim()) fd.set('notes', f.notes.trim());
      if (file) fd.set('file', file);
      return api.upload<ReleaseDto>('/releases', fd);
    },
    onSuccess: (r) => {
      toast.success(`Registered ${r.product_code} ${r.component} ${r.version}`);
      void qc.invalidateQueries({ queryKey: ['releases'] });
      setFile(null);
      setF((x) => ({ ...x, version: '', signature: '', sha256: '', requires_min_version: '', notes: '' }));
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.product_id) return setError('Choose a product');
    if (!SEMVER.test(f.version.trim())) return setError('Version must be semantic, e.g. 1.4.0');
    if (!f.signature.trim()) return setError('The Arnobot signature is required');
    if (!file && !/^[a-f0-9]{64}$/i.test(f.sha256.trim())) return setError('Upload the package, or enter its SHA-256 checksum');
    if (f.sha256.trim() && !/^[a-f0-9]{64}$/i.test(f.sha256.trim())) return setError('SHA-256 must be 64 hex characters');
    if (f.requires_min_version.trim() && !SEMVER.test(f.requires_min_version.trim())) return setError('Minimum version must be semantic, e.g. 0.9.0');
    setError(null);
    m.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Register release"
      description="The server computes the SHA-256 of the uploaded package. If you also enter one, they must match."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="release-form" loading={m.isPending}>
            Register
          </Button>
        </>
      }
    >
      <form id="release-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Product" required>
          <Select value={f.product_id} onChange={(e) => setF({ ...f, product_id: e.target.value })} data-autofocus>
            <option value="">Choose…</option>
            {products.data?.filter((p) => !p.deleted_at).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Component" required>
          <Select value={f.component} onChange={(e) => setF({ ...f, component: e.target.value as ReleaseComponent })}>
            {RELEASE_COMPONENTS.map((c) => (
              <option key={c} value={c}>
                {capital(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Version" required hint="Semantic version, e.g. 1.4.0">
          <Input value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} className="font-mono" />
        </Field>
        <Field label={`Requires ${other} ≥`} hint="Optional minimum version of the other component">
          <Input value={f.requires_min_version} onChange={(e) => setF({ ...f, requires_min_version: e.target.value })} className="font-mono" placeholder="e.g. 0.9.0" />
        </Field>
        <Field label="Update package" className="sm:col-span-2">
          <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="py-1.5" />
        </Field>
        <Field label="SHA-256 (optional check)" className="sm:col-span-2">
          <Input value={f.sha256} onChange={(e) => setF({ ...f, sha256: e.target.value })} className="font-mono" spellCheck={false} />
        </Field>
        <Field label="Signature" required className="sm:col-span-2" hint="Arnobot signature of the package (base64)">
          <Textarea value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} className="font-mono" spellCheck={false} />
        </Field>
        <Field label="Signature algorithm">
          <Input value={f.signature_algo} onChange={(e) => setF({ ...f, signature_algo: e.target.value })} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {error && (
          <div className="sm:col-span-2">
            <InlineAlert tone="fault">{error}</InlineAlert>
          </div>
        )}
      </form>
    </Dialog>
  );
}
