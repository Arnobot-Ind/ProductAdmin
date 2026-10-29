'use client';

import type { AttachmentDto, RobotCategory } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Puzzle, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { mediaUrl } from '@/components/domain/product-media';

export function useAttachments(includeDeleted = false) {
  return useQuery({ queryKey: ['attachments', { includeDeleted }], queryFn: () => api.get<AttachmentDto[]>('/attachments', { include_deleted: includeDeleted }), staleTime: 300_000 });
}

/**
 * One category's attachments (equipment that can be fitted on its vehicles), with how many robots carry each.
 * Attachments that fit both categories show in both. Add, rename or retire them here; fit them on a robot's page.
 */
export function CategoryAttachments({ category, includeDeleted }: { category: RobotCategory; includeDeleted: boolean }) {
  const can = useCan();
  const canWrite = can('catalog.write');
  const q = useAttachments(includeDeleted);
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<AttachmentDto | 'new' | null>(null);
  const list = (q.data ?? []).filter((a) => !a.category || a.category === category);
  const retire = useMutation({
    mutationFn: (a: AttachmentDto) => (a.deleted_at ? api.post(`/attachments/${a.id}/restore`) : api.del(`/attachments/${a.id}`)),
    onSuccess: (_x, a) => {
      toast.success(a.deleted_at ? `${a.name} brought back` : `${a.name} retired`);
      void qc.invalidateQueries({ queryKey: ['attachments'] });
    },
    onError: toast.error,
  });
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Puzzle className="size-5 text-accent-text" aria-hidden /> Attachments <span className="text-base font-normal text-muted">· {list.filter((a) => !a.deleted_at).length}</span>
        </h3>
        {canWrite && (
          <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
            Add attachment
          </Button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-base text-muted">No attachments yet: add the equipment fitted on {category.toUpperCase()}s (e.g. {category === 'uav' ? 'thermal camera, sprayer tank, payload drop' : 'sprayer, thermal camera, robotic arm'}).</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((a) => (
            <li key={a.id} className={cn('flex items-start gap-3 rounded-xl border border-border bg-surface p-3 shadow-sm', a.deleted_at && 'opacity-60')}>
              {a.cover_photo_id ? (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated API image
                <img src={mediaUrl(a.cover_photo_id)} alt="" loading="lazy" className="size-12 shrink-0 rounded-lg border border-border object-cover" />
              ) : (
                <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text" aria-hidden>
                  <Puzzle className="size-5" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2">
                  <Link href={`/attachments/${a.id}`} className="text-base font-semibold text-accent-text hover:underline">
                    {a.name}
                  </Link>
                  {a.model_number && <span className="text-sm text-muted">{a.model_number}</span>}
                  {!a.category && <span className="text-xs text-muted">UGV &amp; UAV</span>}
                  {a.deleted_at && <span className="text-xs font-medium text-fault">Retired</span>}
                </span>
                {a.description && <span className="block text-sm text-muted">{a.description}</span>}
                <span className="flex flex-wrap gap-x-3 text-sm">
                  <Link href={`/robots?attachment=${a.id}`} className="text-accent-text hover:underline">
                    On {a.robot_count} robot{a.robot_count === 1 ? '' : 's'}
                  </Link>
                  {a.revision_count > 0 && <span className="text-muted">{a.revision_count} revision{a.revision_count === 1 ? '' : 's'}</span>}
                  {a.photo_count + a.spin_count > 0 && <span className="text-muted">{a.photo_count + a.spin_count} photo{a.photo_count + a.spin_count === 1 ? '' : 's'}</span>}
                </span>
              </span>
              {canWrite && (
                <span className="flex shrink-0 gap-0.5">
                  {!a.deleted_at && (
                    <button type="button" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
                      <Pencil className="size-4" aria-hidden />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => retire.mutate(a)}
                    aria-label={a.deleted_at ? `Bring back ${a.name}` : `Retire ${a.name}`}
                    title={a.deleted_at ? 'Bring back' : a.robot_count ? 'Remove it from its robots first' : 'Retire (history is kept)'}
                    className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
                  >
                    {a.deleted_at ? <RotateCcw className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <AttachmentDialog value={editing === 'new' ? null : editing} category={category} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Add an attachment to the catalogue, or edit one (name, what it fits, description, maker, model number, software). */
export function AttachmentDialog({ value, category, onClose }: { value: AttachmentDto | null; category: RobotCategory; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(value?.name ?? '');
  const [fits, setFits] = useState<string>(value ? (value.category ?? 'both') : category);
  const [description, setDescription] = useState(value?.description ?? '');
  const [manufacturer, setManufacturer] = useState(value?.manufacturer ?? '');
  const [modelNumber, setModelNumber] = useState(value?.model_number ?? '');
  const [repo, setRepo] = useState(value?.repo_url ?? '');
  const repoBad = !!repo.trim() && !/^https?:\/\/\S+$/i.test(repo.trim());
  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        category: fits === 'both' ? null : fits,
        description: description.trim() || null,
        manufacturer: manufacturer.trim() || null,
        model_number: modelNumber.trim() || null,
        repo_url: repo.trim() || null,
      };
      return value ? api.patch<AttachmentDto>(`/attachments/${value.id}`, body) : api.post<AttachmentDto>('/attachments', body);
    },
    onSuccess: (a) => {
      toast.success(value ? `${a.name} saved` : `${a.name} added`);
      void qc.invalidateQueries({ queryKey: ['attachments'] });
      void qc.invalidateQueries({ queryKey: ['attachment', a.id] });
      void qc.invalidateQueries({ queryKey: ['robots'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={value ? `Edit ${value.name}` : 'Add attachment'}
      description="Equipment that can be fitted on a vehicle. Robots show the attachments fitted on them everywhere they appear."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim() || repoBad}>
            {value ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Sprayer 20 L" data-autofocus />
        </Field>
        <Field label="Fits">
          <Select value={fits} onChange={(e) => setFits(e.target.value)}>
            <option value="ugv">UGV (ground robots)</option>
            <option value="uav">UAV (aerial robots)</option>
            <option value="both">Both</option>
          </Select>
        </Field>
        <Field label="Short description">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="What it is for" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Manufacturer">
            <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} maxLength={100} placeholder="e.g. Arnobot, or the supplier" />
          </Field>
          <Field label="Model / part number">
            <Input value={modelNumber} onChange={(e) => setModelNumber(e.target.value)} maxLength={100} placeholder="e.g. SPR-20" spellCheck={false} />
          </Field>
        </div>
        <Field label="Software repository" hint="Only if it runs software of its own" error={repoBad ? 'A web link starting with https://' : null}>
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/…" spellCheck={false} />
        </Field>
      </div>
    </Dialog>
  );
}
