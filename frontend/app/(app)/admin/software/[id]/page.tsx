'use client';

import type { DocumentDto, SoftwareDetailDto, SoftwareInstallAtDto, SoftwareVersionDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { DocumentsPanel } from '@/components/domain/documents-panel';
import { ProductMediaCard } from '@/components/domain/product-media';
import { RobotRef } from '@/components/domain/robot-ref';
import { KIND_LABELS, ProductDialog } from '@/components/domain/software';
import { isCommitId, SourceLink } from '@/components/domain/source-link';
import { BesideBack } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Badge, Card, EmptyState, KeyValue, Mono, PageHeader, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDate, fmtWhen } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';

export default function SoftwareDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['software', id], queryFn: () => api.get<SoftwareDetailDto>(`/software-products/${id}`) });
  return <QueryView query={q}>{(s) => <SoftwareView s={s} />}</QueryView>;
}

/**
 * One software item, kept like a base model: what it is, its latest version and where it was built from, every
 * version with its commit and what changed, screenshots, where it is installed, and its documents.
 */
function SoftwareView({ s }: { s: SoftwareDetailDto }) {
  useDocumentTitle(s.name);
  const can = useCan();
  const canWrite = can('org.manage') && !s.deleted_at;
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SoftwareVersionDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const installs = useQuery({ queryKey: ['software', s.id, 'installs'], queryFn: () => api.get<SoftwareInstallAtDto[]>(`/software-products/${s.id}/installs`) });
  const docs = useQuery({ queryKey: ['software', s.id, 'documents'], queryFn: () => api.get<DocumentDto[]>(`/software-products/${s.id}/documents`) });
  const latest = s.versions[0];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['software', s.id] });
    void qc.invalidateQueries({ queryKey: ['software-products'] });
  };
  const remove = useMutation({
    mutationFn: (v: SoftwareVersionDto) => api.del(`/software-versions/${v.id}`),
    onSuccess: () => {
      toast.success('Version removed');
      setRemoving(null);
      refresh();
    },
    onError: toast.error,
  });

  return (
    <>
      <BesideBack>
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
          <Link href="/admin/software" className="hover:underline">
            Client software
          </Link>{' '}
          / <span aria-current="page">{s.name}</span>
        </nav>
      </BesideBack>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {s.name} <Badge>{KIND_LABELS[s.kind]}</Badge> {s.deleted_at && <Badge tone="fault">Deleted</Badge>}
          </span>
        }
        description={s.description ?? undefined}
        actions={
          canWrite ? (
            <Button icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-6">
        <Card title="Software">
          <KeyValue
            columns={3}
            items={[
              {
                label: 'Latest version',
                value: s.latest_version ? (
                  <span className="block">
                    <span className="font-mono text-lg font-semibold">{s.latest_version}</span>
                    {latest && <span className="block text-sm text-muted">released {fmtDate(latest.released_at)}</span>}
                  </span>
                ) : (
                  <span className="text-muted">Not recorded yet</span>
                ),
              },
              { label: 'Commit of the latest version', value: s.commit_id ? <SourceLink repo={s.repo_url} commit={s.commit_id} /> : null },
              {
                label: 'GitHub repository',
                value: s.repo_url ? (
                  <a href={s.repo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-accent-text hover:underline">
                    {s.repo_url} <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                  </a>
                ) : null,
              },
              { label: 'Kind', value: KIND_LABELS[s.kind] },
              { label: 'Code (permanent)', value: <Mono>{s.code}</Mono> },
              { label: 'Installed', value: `${s.install_count} place${s.install_count === 1 ? '' : 's'} at clients` },
              { label: 'Versions recorded', value: s.versions.length },
              { label: 'Added', value: fmtWhen(s.created_at) },
              { label: 'Last changed', value: fmtWhen(s.updated_at) },
            ]}
          />
        </Card>

        <Card
          title="Versions"
          actions={
            canWrite ? (
              <Button size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
                Add version
              </Button>
            ) : undefined
          }
        >
          {s.versions.length === 0 ? (
            <EmptyState icon={<Tag className="size-8" />} title="No versions yet" description="Record each release with its commit and what changed; the newest becomes the latest version." />
          ) : (
            <DataTable
              caption={`Versions of ${s.name}`}
              compact
              rows={s.versions}
              rowKey={(v) => v.id}
              columns={[
                {
                  key: 'v',
                  header: 'Version',
                  rowHeader: true,
                  cell: (v) => (
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <span className="font-mono font-semibold">{v.version}</span>
                      {v.id === latest?.id && <Badge tone="ok">Latest</Badge>}
                    </span>
                  ),
                },
                { key: 'd', header: 'Released', className: 'whitespace-nowrap', cell: (v) => fmtDate(v.released_at) },
                { key: 'c', header: 'Commit', cell: (v) => (v.commit_id ? <SourceLink repo={s.repo_url} commit={v.commit_id} /> : <span className="text-muted">—</span>) },
                { key: 'n', header: 'What changed', cell: (v) => (v.notes ? <span className="block max-w-xl whitespace-pre-line">{v.notes}</span> : <span className="text-muted">—</span>) },
                { key: 'i', header: 'Installed', align: 'right', className: 'hidden md:table-cell', cell: (v) => v.install_count },
                { key: 'b', header: 'Recorded by', className: 'hidden lg:table-cell', cell: (v) => v.created_by_name ?? <span className="text-muted">—</span> },
                ...(canWrite
                  ? [
                      {
                        key: 'x',
                        header: <span className="sr-only">Actions</span>,
                        cell: (v: SoftwareVersionDto) => (
                          <button type="button" onClick={() => setRemoving(v)} aria-label={`Remove version ${v.version}`} title="Remove (recorded by mistake)" className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fault">
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </Card>

        <ProductMediaCard owner="software-products" productId={s.id} name={s.name} photosOnly />

        <Card title="Installed at">
          <QueryView query={installs} rows={2}>
            {(list) =>
              list.length === 0 ? (
                <p className="text-base text-muted">Not installed at any client yet. Installs are recorded on each organization's page (Software tab).</p>
              ) : (
                <DataTable
                  caption={`Where ${s.name} is installed`}
                  compact
                  rows={list}
                  rowKey={(i) => i.id}
                  columns={[
                    {
                      key: 'c',
                      header: 'Client',
                      rowHeader: true,
                      cell: (i) => (
                        <Link href={`/admin/organizations/${i.company_id}?tab=software`} className="font-medium text-accent-text hover:underline">
                          {i.company_name}
                        </Link>
                      ),
                    },
                    { key: 'w', header: 'Where', cell: (i) => (i.robot_id ? <RobotRef id={i.robot_id} /> : (i.host_label ?? <span className="text-muted">—</span>)) },
                    {
                      key: 'v',
                      header: 'Version',
                      cell: (i) => (
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono">{i.version}</span>
                          {i.update_available && <Badge tone="warn">Update available</Badge>}
                        </span>
                      ),
                    },
                    { key: 'l', header: 'Licence until', className: 'hidden md:table-cell', cell: (i) => (i.licence_valid_until ? fmtDate(i.licence_valid_until) : <span className="text-muted">—</span>) },
                  ]}
                />
              )
            }
          </QueryView>
        </Card>

        <Card title="Documents">
          <QueryView query={docs}>
            {(list) => (
              <DocumentsPanel
                documents={list}
                invalidateKey={['software', s.id, 'documents']}
                owners={s.deleted_at ? [] : [{ label: s.name, owner: { software_product_id: s.id } }]}
                emptyText="No documents yet: add the user manual, install guide, release notes …"
              />
            )}
          </QueryView>
        </Card>
      </div>

      {editing && <ProductDialog product={s} onClose={() => setEditing(false)} />}
      {adding && <VersionDialog s={s} onClose={() => setAdding(false)} onDone={refresh} />}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        loading={remove.isPending}
        danger
        title={`Remove version ${removing?.version ?? ''}?`}
        description="Only for a version recorded by mistake. The latest version then follows the newest remaining one."
        confirmLabel="Remove"
      />
    </>
  );
}

/** Record a release: version, commit, date and what changed. */
function VersionDialog({ s, onClose, onDone }: { s: SoftwareDetailDto; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [version, setVersion] = useState('');
  const [commit, setCommit] = useState('');
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState('');
  const commitBad = !!commit.trim() && !isCommitId(commit.trim());
  const m = useMutation({
    mutationFn: () => api.post(`/software-products/${s.id}/versions`, { version: version.trim(), commit_id: commit.trim() || null, released_at: date || undefined, notes: notes.trim() || null }),
    onSuccess: () => {
      toast.success(`Version ${version.trim()} recorded`);
      onDone();
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`New version of ${s.name}`}
      description={s.latest_version ? `Latest now: ${s.latest_version}. The newest release becomes the latest version.` : 'The newest release becomes the latest version.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!version.trim() || commitBad}>
            Record version
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Version" required>
          <Input value={version} onChange={(e) => setVersion(e.target.value)} maxLength={64} className="font-mono" placeholder="1.4.0" data-autofocus />
        </Field>
        <Field label="Released on">
          <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Commit ID" hint={s.repo_url ? 'Links to the commit on GitHub' : 'Add the GitHub link (Edit) to make it clickable'} error={commitBad ? '7–64 letters a–f and digits' : null} className="sm:col-span-2">
          <Input value={commit} onChange={(e) => setCommit(e.target.value)} className="font-mono" spellCheck={false} placeholder="3f9c2ab" />
        </Field>
        <Field label="What changed" className="sm:col-span-2">
          <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} placeholder={'New: …\nFixed: …'} />
        </Field>
      </div>
    </Dialog>
  );
}
