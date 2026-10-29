'use client';

import type { HardwareRevisionDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Badge, Card, EmptyState } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { usePartTypes } from '@/lib/queries';

/** Whose revisions: a base model's (`/products/:id`) or an attachment's (`/attachments/:id`). */
export type RevisionOwner = 'products' | 'attachments';
export const revisionOwnerKey = (owner: RevisionOwner) => (owner === 'products' ? 'product' : 'attachment');

interface ComponentRow {
  part_type_key: string;
  slot: string;
  model: string;
}

/**
 * Hardware revisions with their main components, for a base model or an attachment. A revision names one set of
 * main components; a new one is made when a main component changes.
 */
export function RevisionsCard({ owner, ownerId, revisions, readOnly }: { owner: RevisionOwner; ownerId: string; revisions: HardwareRevisionDto[]; readOnly?: boolean }) {
  const can = useCan();
  const canWrite = can('catalog.write') && !readOnly;
  const qc = useQueryClient();
  const toast = useToast();
  const key = revisionOwnerKey(owner);
  const [showDeleted, setShowDeleted] = useState(false);
  const [dialog, setDialog] = useState<HardwareRevisionDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<HardwareRevisionDto | null>(null);
  const all = useQuery({
    queryKey: [key, ownerId, 'revisions', 'all'],
    queryFn: () => api.get<{ revisions: HardwareRevisionDto[] }>(`/${owner}/${ownerId}`, { include_deleted: true }),
    enabled: showDeleted,
  });
  const list = showDeleted ? (all.data?.revisions ?? revisions) : revisions;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: [key, ownerId] });
    void qc.invalidateQueries({ queryKey: [owner] });
  };
  const del = useMutation({
    mutationFn: (r: HardwareRevisionDto) => (r.deleted_at ? api.post(`/revisions/${r.id}/restore`) : api.del(`/revisions/${r.id}`)),
    onSuccess: (_x, r) => {
      toast.success(r.deleted_at ? 'Revision restored' : 'Revision deleted (restorable)');
      setDeleting(null);
      invalidate();
    },
    onError: toast.error,
  });
  const robots = (r: HardwareRevisionDto) =>
    owner === 'products' ? `${r.robot_count} robot${r.robot_count === 1 ? '' : 's'}` : `Fitted on ${r.robot_count} robot${r.robot_count === 1 ? '' : 's'} now`;

  return (
    <Card
      title="Hardware revisions"
      actions={
        <>
          <Checkbox label="Show deleted" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          {canWrite && (
            <Button size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setDialog('new')}>
              Add revision
            </Button>
          )}
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        A revision names one set of main components. Create a new revision when a main component changes.
        {owner === 'attachments' ? ' When fitting the attachment on a robot, choose which revision it is.' : ' Optional in v1.'}
      </p>
      {list.length === 0 ? (
        <EmptyState title="No revisions" description={owner === 'products' ? 'Robots of this base model can be registered without a revision.' : 'The attachment can be fitted without choosing a revision.'} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.map((r) => (
            <article key={r.id} className={`rounded-md border border-border p-4 ${r.deleted_at ? 'opacity-60' : ''}`} aria-labelledby={`rev-${r.id}`}>
              <header className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 id={`rev-${r.id}`} className="font-semibold">
                    {r.name} {r.deleted_at && <Badge tone="fault">Deleted</Badge>}
                  </h3>
                  {r.description && <p className="text-sm text-muted">{r.description}</p>}
                  <p className="text-xs text-muted">{robots(r)}</p>
                </div>
                {canWrite && (
                  <span className="flex gap-1">
                    {!r.deleted_at && (
                      <Button size="sm" variant="ghost" onClick={() => setDialog(r)} aria-label={`Edit ${r.name}`} icon={<Pencil className="size-3.5" aria-hidden />}>
                        Edit
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => (r.deleted_at ? del.mutate(r) : setDeleting(r))}
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

      <RevisionDialog owner={owner} ownerId={ownerId} value={dialog} onClose={() => setDialog(null)} onSaved={invalidate} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        loading={del.isPending}
        danger
        title={`Delete ${deleting?.name ?? ''}?`}
        description={
          owner === 'products'
            ? 'Hidden from new registrations; robots already on this revision keep it. Restorable.'
            : 'It can no longer be chosen when fitting; robots that have it fitted keep it. Restorable.'
        }
        confirmLabel="Delete revision"
      />
    </Card>
  );
}

function RevisionDialog({
  owner,
  ownerId,
  value,
  onClose,
  onSaved,
}: {
  owner: RevisionOwner;
  ownerId: string;
  value: HardwareRevisionDto | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = value && value !== 'new' ? value : null;
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
      return api.post<HardwareRevisionDto>(`/${owner}/${ownerId}/revisions`, { name: name.trim(), description: description.trim() || undefined, components });
    },
    onSuccess: () => {
      toast.success(existing ? 'Revision updated' : 'Revision added');
      onSaved();
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
