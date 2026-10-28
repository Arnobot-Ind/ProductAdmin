'use client';

import type { DocumentDto, DocumentType, DocumentVersionDto } from '@arnobot/message-schema';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { CheckCircle2, Download, Eye, FilePlus2, History, Loader2, RotateCcw, Trash2, Upload, UploadCloud, X, XCircle } from 'lucide-react';
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, EmptyState, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, downloadUrl, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtBytes, humanize } from '@/lib/format';
import { DOCUMENT_TYPES } from '@/lib/schema';
import { cn } from '@/lib/cn';

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
  const [previewing, setPreviewing] = useState<{ version: DocumentVersionDto; title: string } | null>(null);
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
            Add documents
          </Button>
        </div>
      )}
      {documents.length === 0 ? (
        <EmptyState title={emptyText} description="Add manuals, circuit diagrams, BOMs, photos, videos or any other file. Upload several at once; each can be updated later with a new version." />
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
            {
              key: 'file',
              header: 'Latest file',
              cell: (d) =>
                d.latest ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{fileKind(d.latest.file.content_type, d.latest.file.filename)}</Badge>
                    <span className="break-all">{d.latest.file.filename}</span>
                    <span className="text-muted">({fmtBytes(d.latest.file.size_bytes)})</span>
                  </span>
                ) : (
                  '—'
                ),
            },
            { key: 'up', header: 'Uploaded', cell: (d) => (d.latest ? <span><Time iso={d.latest.uploaded_at} /> · {d.latest.uploaded_by_name ?? '—'}</span> : '—') },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              cell: (d) => (
                <span className="flex justify-end gap-1">
                  {d.latest && <PreviewButton version={d.latest} title={d.title} onOpen={setPreviewing} />}
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
                header: <span className="sr-only">Open</span>,
                cell: (v) => (
                  <span className="flex items-center gap-3">
                    <PreviewButton version={v} title={`${historyFor.title} v${v.version_no}`} onOpen={setPreviewing} compact />
                    <a className="text-accent-text underline" href={downloadUrl(`/document-versions/${v.id}/download`)}>
                      Download<span className="sr-only"> version {v.version_no}</span>
                    </a>
                  </span>
                ),
              },
            ]}
          />
        )}
      </Dialog>
      <PreviewDialog preview={previewing} onClose={() => setPreviewing(null)} />
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

type PendingFile = { file: File; title: string; status: 'waiting' | 'uploading' | 'done' | 'failed'; error?: string };

const stripExtension = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name;

/** Add one or many files; each file becomes its own document (version 1), titled from its file name. */
function AddDocumentDialog({ open, onClose, owners, invalidateKey }: { open: boolean; onClose: () => void; owners: OwnerOption[]; invalidateKey: QueryKey }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ownerIdx, setOwnerIdx] = useState(0);
  const [docType, setDocType] = useState<DocumentType>('manual');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addFiles = (files: File[]) => {
    setError(null);
    setItems((cur) => [...cur.filter((i) => i.status !== 'done'), ...files.map((file) => ({ file, title: stripExtension(file.name), status: 'waiting' as const }))]);
  };
  const reset = () => {
    setItems([]);
    setNote('');
    setError(null);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  // One request per file, in order, so a large batch never overloads the server and each file reports its own result.
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const todo = items.filter((i) => i.status !== 'done');
    if (!todo.length) return setError('Choose at least one file');
    if (todo.some((i) => !i.title.trim())) return setError('Every file needs a title');
    setError(null);
    setBusy(true);
    const owner = owners[ownerIdx]?.owner ?? owners[0].owner;
    let ok = 0;
    for (const item of todo) {
      setItems((cur) => cur.map((i) => (i === item ? { ...i, status: 'uploading' } : i)));
      try {
        const fd = new FormData();
        fd.set('doc_type', docType);
        fd.set('title', item.title.trim());
        if (note.trim()) fd.set('note', note.trim());
        for (const [k, v] of Object.entries(owner)) fd.set(k, v);
        fd.set('file', item.file);
        await api.upload<DocumentDto>('/documents', fd);
        ok++;
        setItems((cur) => cur.map((i) => (i.file === item.file ? { ...i, status: 'done' } : i)));
      } catch (err) {
        setItems((cur) => cur.map((i) => (i.file === item.file ? { ...i, status: 'failed', error: errorMessage(err) } : i)));
      }
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: invalidateKey });
    if (ok === todo.length) {
      toast.success(ok === 1 ? 'Document uploaded' : `${ok} documents uploaded`);
      reset();
      onClose();
    } else {
      toast.error(`${ok} of ${todo.length} uploaded. Check the failed files and try again.`);
    }
  };

  const pending = items.filter((i) => i.status !== 'done').length;
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Add documents"
      description="Any file: documents, drawings, spreadsheets, photos, videos (up to 1 GB each). Each file becomes its own document; upload a new version of it any time later."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="add-doc-form" loading={busy} disabled={!pending}>
            {pending > 1 ? `Upload ${pending} files` : 'Upload'}
          </Button>
        </>
      }
    >
      <form id="add-doc-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {owners.length > 1 && (
          <Field label="Attach to" className="sm:col-span-2" hint="Documents shared by every robot of a product belong on the product or revision, not on each robot.">
            <Select value={ownerIdx} onChange={(e) => setOwnerIdx(Number(e.target.value))} disabled={busy}>
              {owners.map((o, i) => (
                <option key={o.label} value={i}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Type" required hint="Applies to every file in this upload.">
          <Select value={docType} onChange={(e) => setDocType(e.target.value as DocumentType)} disabled={busy}>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note" hint="Optional, saved with version 1 of each file.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} disabled={busy} />
        </Field>
        <div className="sm:col-span-2">
          <DropZone multiple onFiles={addFiles} disabled={busy} />
          {error && <p className="mt-2 text-sm text-fault" role="alert">{error}</p>}
        </div>
        {items.length > 0 && (
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto sm:col-span-2" aria-label="Files to upload">
            {items.map((i, idx) => (
              <li key={`${i.file.name}-${idx}`} className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
                <StatusIcon status={i.status} />
                <span className="min-w-0 flex-1">
                  <Input
                    value={i.title}
                    onChange={(e) => setItems((cur) => cur.map((x) => (x === i ? { ...x, title: e.target.value } : x)))}
                    maxLength={300}
                    disabled={busy || i.status === 'done'}
                    aria-label={`Title for ${i.file.name}`}
                  />
                  <span className="mt-1 block truncate text-sm text-muted">
                    {fileKind(i.file.type, i.file.name)} · {i.file.name} · {fmtBytes(i.file.size)}
                    {i.error && <span className="text-fault"> · {i.error}</span>}
                  </span>
                </span>
                {!busy && i.status !== 'done' && (
                  <button type="button" className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-fg" onClick={() => setItems((cur) => cur.filter((x) => x !== i))} aria-label={`Remove ${i.file.name}`}>
                    <X className="size-4" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </form>
    </Dialog>
  );
}

function StatusIcon({ status }: { status: PendingFile['status'] }) {
  if (status === 'uploading') return <Loader2 className="size-5 shrink-0 animate-spin text-accent-text" aria-label="Uploading" />;
  if (status === 'done') return <CheckCircle2 className="size-5 shrink-0 text-ok" aria-label="Uploaded" />;
  if (status === 'failed') return <XCircle className="size-5 shrink-0 text-fault" aria-label="Failed" />;
  return <FilePlus2 className="size-5 shrink-0 text-muted" aria-label="Waiting" />;
}

/** Drag files here or click to choose them. */
function DropZone({ multiple, onFiles, disabled }: { multiple?: boolean; onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn('flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors', over ? 'border-accent bg-accent-soft' : 'border-border', disabled && 'opacity-60')}
    >
      <UploadCloud className="size-8 text-accent-text" aria-hidden />
      <p className="text-base font-medium">{multiple ? 'Drag files here' : 'Drag the new file here'}</p>
      <p className="text-sm text-muted">or</p>
      <Button type="button" size="sm" onClick={() => input.current?.click()} disabled={disabled}>
        {multiple ? 'Choose files' : 'Choose file'}
      </Button>
      <input
        ref={input}
        type="file"
        multiple={multiple}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = '';
        }}
      />
    </div>
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
        <div>
          <DropZone onFiles={(f) => setFile(f[0] ?? null)} disabled={m.isPending} />
          {file && (
            <p className="mt-2 text-sm">
              <span className="font-medium">{file.name}</span> <span className="text-muted">· {fileKind(file.type, file.name)} · {fmtBytes(file.size)}</span>
            </p>
          )}
        </div>
        <Field label="What changed?">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Dialog>
  );
}

// ── file kinds and preview ──────────────────────────────────────────────────

const EXT_KIND: [RegExp, string][] = [
  [/\.(dwg|dxf|step|stp|iges|igs|stl|sldprt|sldasm|f3d|ipt|iam)$/i, 'CAD'],
  [/\.(xlsx?|csv|ods)$/i, 'Spreadsheet'],
  [/\.(docx?|odt|rtf)$/i, 'Document'],
  [/\.(pptx?|odp)$/i, 'Slides'],
  [/\.(zip|rar|7z|tar|gz|tgz)$/i, 'Archive'],
  [/\.(md|txt|log)$/i, 'Text'],
];

/** A short, human label for what a file is (shown next to its name). */
export function fileKind(contentType: string | null | undefined, filename: string): string {
  const t = (contentType ?? '').toLowerCase();
  if (t.startsWith('image/')) return 'Image';
  if (t.startsWith('video/')) return 'Video';
  if (t.startsWith('audio/')) return 'Audio';
  if (t === 'application/pdf') return 'PDF';
  return EXT_KIND.find(([re]) => re.test(filename))?.[1] ?? (t.startsWith('text/') ? 'Text' : 'File');
}

type PreviewKind = 'image' | 'video' | 'audio' | 'tab' | null;
/** Matches the server's inline allow-list (files.service.ts): anything else only downloads. */
function previewKind(contentType: string | null | undefined): PreviewKind {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(t)) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf' || t === 'text/plain') return 'tab';
  return null;
}
const inlineUrl = (v: DocumentVersionDto) => downloadUrl(`/document-versions/${v.id}/download?inline=1`);

function PreviewButton({ version, title, onOpen, compact }: { version: DocumentVersionDto; title: string; onOpen: (p: { version: DocumentVersionDto; title: string }) => void; compact?: boolean }) {
  const kind = previewKind(version.file.content_type);
  if (!kind) return null;
  const cls = compact ? 'text-accent-text underline' : 'inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-surface-2';
  // PDFs and text open in a new tab (the browser's own viewer); images, video and audio open here.
  if (kind === 'tab')
    return (
      <a className={cls} href={inlineUrl(version)} target="_blank" rel="noopener noreferrer" aria-label={`View ${title} in a new tab`}>
        {!compact && <Eye className="size-4" aria-hidden />} View
      </a>
    );
  return (
    <button type="button" className={cls} onClick={() => onOpen({ version, title })} aria-label={`View ${title}`}>
      {!compact && <Eye className="size-4" aria-hidden />} View
    </button>
  );
}

function PreviewDialog({ preview, onClose }: { preview: { version: DocumentVersionDto; title: string } | null; onClose: () => void }) {
  const kind = preview ? previewKind(preview.version.file.content_type) : null;
  return (
    <Dialog
      open={!!preview}
      onClose={onClose}
      size="xl"
      title={preview?.title ?? ''}
      description={preview ? `${preview.version.file.filename} · v${preview.version.version_no} · ${fmtBytes(preview.version.file.size_bytes)}` : undefined}
      footer={
        preview && (
          <>
            <a className="inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-accent-text hover:bg-surface-2" href={downloadUrl(`/document-versions/${preview.version.id}/download`)}>
              <Download className="size-4" aria-hidden /> Download
            </a>
            <Button onClick={onClose}>Close</Button>
          </>
        )
      }
    >
      {preview && (
        <div className="flex justify-center rounded-lg bg-black/90 p-2">
          {kind === 'image' && <img src={inlineUrl(preview.version)} alt={preview.title} className="max-h-[70vh] w-auto object-contain" />}
          {kind === 'video' && <video src={inlineUrl(preview.version)} controls playsInline className="max-h-[70vh] w-full" />}
          {kind === 'audio' && <audio src={inlineUrl(preview.version)} controls className="my-8 w-full max-w-xl" />}
        </div>
      )}
    </Dialog>
  );
}
