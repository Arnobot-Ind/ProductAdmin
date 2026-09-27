'use client';

import type { DocumentDto, DocumentType } from '@arnobot/message-schema';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Download, FilePlus2, History, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, EmptyState, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, downloadUrl } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtBytes, humanize } from '@/lib/format';
import { DOCUMENT_TYPES } from '@/lib/schema';

export type DocOwner = { product_id: string } | { hardware_revision_id: string } | { robot_id: string };
export interface OwnerOption {
  label: string;
  owner: DocOwner;
}

/**
 * Versioned documents (spec §3 row 7, §8): latest version shown, older versions kept and listed,
 * every upload is a new version with number, uploader and date.
 */
export function DocumentsPanel({
  documents,
  invalidateKey,
  owners,
  emptyText = 'No documents yet.',
  showSource = true,
}: {
  documents: DocumentDto[];
  invalidateKey: QueryKey;
  /** Where a new document can be attached. Empty = no "Add" button. */
  owners: OwnerOption[];
  emptyText?: string;
  showSource?: boolean;
}) {
  const can = useCan();
  const canWrite = can('document.write');
  const [adding, setAdding] = useState(false);
  const [versionFor, setVersionFor] = useState<DocumentDto | null>(null);
  const [historyFor, setHistoryFor] = useState<DocumentDto | null>(null);
  const [deleting, setDeleting] = useState<DocumentDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const del = useMutation({
    mutationFn: (d: DocumentDto) => (d.deleted_at ? api.post(`/documents/${d.id}/restore`) : api.del(`/documents/${d.id}`)),
    onSuccess: (_r, d) => {
      toast.success(d.deleted_at ? 'Document restored' : 'Document deleted (restorable)');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: invalidateKey });
    },
    onError: toast.error,
  });

  return (
    <div className="flex flex-col gap-3">
      {canWrite && owners.length > 0 && (
        <div className="flex justify-end">
          <Button variant="primary" icon={<FilePlus2 className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
            Add document
          </Button>
        </div>
      )}
      {documents.length === 0 ? (
        <EmptyState title={emptyText} description="Circuit diagrams, pinouts, BOMs, manuals and component lists are stored in S3; the PMS keeps the path and version history." />
      ) : (
        <DataTable
          caption="Documents"
          rows={documents}
          rowKey={(d) => d.id}
          rowClassName={(d) => (d.deleted_at ? 'opacity-60' : undefined)}
          columns={[
            {
              key: 'title',
              header: 'Title',
              rowHeader: true,
              cell: (d) => (
                <span className="flex flex-wrap items-center gap-2">
                  {d.title}
                  {d.deleted_at && <Badge tone="fault">Deleted</Badge>}
                </span>
              ),
            },
            { key: 'type', header: 'Type', cell: (d) => humanize(d.doc_type) },
            ...(showSource ? [{ key: 'source', header: 'Attached to', cell: (d: DocumentDto) => <Badge tone="accent">{d.source_label}</Badge> }] : []),
            { key: 'ver', header: 'Version', align: 'right' as const, cell: (d) => (d.latest ? `v${d.latest.version_no}` : '—') },
            { key: 'file', header: 'Latest file', cell: (d) => (d.latest ? `${d.latest.file.filename} (${fmtBytes(d.latest.file.size_bytes)})` : '—') },
            { key: 'up', header: 'Uploaded', cell: (d) => (d.latest ? <span><Time iso={d.latest.uploaded_at} /> · {d.latest.uploaded_by_name ?? '—'}</span> : '—') },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (d) => (
                <span className="flex justify-end gap-1">
                  {d.latest && (
                    <a className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-surface-2" href={downloadUrl(`/document-versions/${d.latest.id}/download`)} aria-label={`Download latest version of ${d.title}`}>
                      <Download className="size-4" aria-hidden /> Download
                    </a>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setHistoryFor(d)} icon={<History className="size-4" aria-hidden />} aria-label={`Version history of ${d.title}`}>
                    History
                  </Button>
                  {canWrite && !d.deleted_at && (
                    <Button size="sm" variant="ghost" onClick={() => setVersionFor(d)} icon={<Upload className="size-4" aria-hidden />} aria-label={`Upload new version of ${d.title}`}>
                      New version
                    </Button>
                  )}
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => (d.deleted_at ? del.mutate(d) : setDeleting(d))}
                      icon={d.deleted_at ? <RotateCcw className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                      aria-label={d.deleted_at ? `Restore ${d.title}` : `Delete ${d.title}`}
                    >
                      {d.deleted_at ? 'Restore' : 'Delete'}
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}

      <AddDocumentDialog open={adding} onClose={() => setAdding(false)} owners={owners} invalidateKey={invalidateKey} />
      <NewVersionDialog doc={versionFor} onClose={() => setVersionFor(null)} invalidateKey={invalidateKey} />
      <Dialog open={!!historyFor} onClose={() => setHistoryFor(null)} title={`Version history: ${historyFor?.title ?? ''}`} size="lg">
        {historyFor && (
          <DataTable
            caption="Document versions"
            rows={[...historyFor.versions].sort((a, b) => b.version_no - a.version_no)}
            rowKey={(v) => v.id}
            dense
            columns={[
              { key: 'v', header: 'Version', rowHeader: true, cell: (v) => `v${v.version_no}` },
              { key: 'f', header: 'File', cell: (v) => v.file.filename },
              { key: 's', header: 'Size', align: 'right', cell: (v) => fmtBytes(v.file.size_bytes) },
              { key: 'sha', header: 'SHA-256', cell: (v) => <code className="font-mono text-xs" title={v.file.sha256 ?? ''}>{v.file.sha256?.slice(0, 12) ?? '—'}…</code> },
              { key: 'by', header: 'Uploaded', cell: (v) => <span><Time iso={v.uploaded_at} /> · {v.uploaded_by_name ?? '—'}</span> },
              { key: 'n', header: 'Note', cell: (v) => v.note ?? '—' },
              {
                key: 'd',
                header: <span className="sr-only">Download</span>,
                cell: (v) => (
                  <a className="text-accent-text underline" href={downloadUrl(`/document-versions/${v.id}/download`)}>
                    Download<span className="sr-only"> version {v.version_no}</span>
                  </a>
                ),
              },
            ]}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        loading={del.isPending}
        danger
        title="Delete document?"
        description="The document is marked deleted and hidden. It and all its versions stay in storage and can be restored."
        confirmLabel="Delete"
      />
    </div>
  );
}

function AddDocumentDialog({ open, onClose, owners, invalidateKey }: { open: boolean; onClose: () => void; owners: OwnerOption[]; invalidateKey: QueryKey }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ownerIdx, setOwnerIdx] = useState(0);
  const [docType, setDocType] = useState<DocumentType>('manual');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('doc_type', docType);
      fd.set('title', title.trim());
      if (note.trim()) fd.set('note', note.trim());
      const owner = owners[ownerIdx]?.owner ?? owners[0].owner;
      for (const [k, v] of Object.entries(owner)) fd.set(k, v);
      fd.set('file', file!);
      return api.upload<DocumentDto>('/documents', fd);
    },
    onSuccess: () => {
      toast.success('Document uploaded (v1)');
      void qc.invalidateQueries({ queryKey: invalidateKey });
      setTitle('');
      setNote('');
      setFile(null);
      onClose();
    },
    onError: toast.error,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('Title is required');
    if (!file) return setError('Choose a file');
    setError(null);
    m.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add document"
      description="The file is stored in S3; each later upload becomes a new version."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-doc-form" loading={m.isPending}>
            Upload
          </Button>
        </>
      }
    >
      <form id="add-doc-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {owners.length > 1 && (
          <Field label="Attach to" className="sm:col-span-2" hint="Documents shared by every robot of a product belong on the product or revision, not on each robot.">
            <Select value={ownerIdx} onChange={(e) => setOwnerIdx(Number(e.target.value))}>
              {owners.map((o, i) => (
                <option key={o.label} value={i}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Type" required>
          <Select value={docType} onChange={(e) => setDocType(e.target.value as DocumentType)}>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" required error={error && !title.trim() ? error : null}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} data-autofocus />
        </Field>
        <Field label="File" required className="sm:col-span-2" error={error && !file ? error : null}>
          <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="py-1.5" />
        </Field>
        <Field label="Version note" className="sm:col-span-2">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </form>
    </Dialog>
  );
}

function NewVersionDialog({ doc, onClose, invalidateKey }: { doc: DocumentDto | null; onClose: () => void; invalidateKey: QueryKey }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('file', file!);
      if (note.trim()) fd.set('note', note.trim());
      return api.upload<DocumentDto>(`/documents/${doc!.id}/versions`, fd);
    },
    onSuccess: (d) => {
      toast.success(`Uploaded v${d.latest?.version_no ?? ''}`);
      void qc.invalidateQueries({ queryKey: invalidateKey });
      setFile(null);
      setNote('');
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!doc}
      onClose={onClose}
      title={`New version: ${doc?.title ?? ''}`}
      description={doc?.latest ? `Current: v${doc.latest.version_no}. Older versions stay available.` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} disabled={!file} loading={m.isPending}>
            Upload version
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="File" required>
          <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="py-1.5" data-autofocus />
        </Field>
        <Field label="What changed?">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Dialog>
  );
}
