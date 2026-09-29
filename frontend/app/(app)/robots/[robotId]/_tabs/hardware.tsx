'use client';

import type { HardwarePartDto, PartTypeDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, History, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, EmptyState, Mono, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDateTime, todayDate } from '@/lib/format';
import { usePartTypes } from '@/lib/queries';

const URL_RE = /^https?:\/\/[^\s/@]+(\/\S*)?$/i;
const urlError = (v: string) => (v.trim() && !URL_RE.test(v.trim()) ? 'Must start with http:// or https://' : null);

/** Placeholder for an empty slot's model, per part type. */
const MODEL_HINT: Record<string, string> = {
  gps: 'e.g. u-blox ZED-F9P',
  imu: 'e.g. WitMotion HWT905',
  lidar: 'e.g. RPLIDAR C1',
  controller: 'e.g. Jetson Orin',
  camera: 'e.g. Hikvision IP camera',
  encoder: 'e.g. Hall encoder',
};

interface Draft {
  model: string;
  serial_number: string;
  product_url: string;
  fitted_at: string;
}
/** One editable line: a fitted part, or an empty slot that becomes a fitted part when filled in. */
interface Slot {
  key: string;
  typeKey: string;
  label: string;
  slot: number | null;
  part: HardwarePartDto | null;
}

const toDraft = (p: HardwarePartDto | null): Draft => ({
  model: p?.model ?? '',
  serial_number: p?.serial_number ?? '',
  product_url: p?.product_url ?? '',
  fitted_at: p?.fitted_at ?? '',
});
const same = (a: Draft, b: Draft) => (Object.keys(a) as (keyof Draft)[]).every((k) => a[k].trim() === b[k].trim());
const filled = (d: Draft) => !!(d.model.trim() || d.serial_number.trim() || d.product_url.trim());

/**
 * Spec §3 row 3: one entry per part. Edited in place like Connectivity: change any field and Save.
 * Filling an empty slot fits that part; a different part in a slot is Remove, then fill the slot again,
 * so the hardware history stays true.
 */
export function HardwareTab({ robotId }: { robotId: string }) {
  const types = usePartTypes();
  const current = useQuery({
    queryKey: ['robot', robotId, 'hardware', false],
    queryFn: () => api.get<HardwarePartDto[]>(`/robots/${robotId}/hardware`, { current: true }),
  });
  const q = { data: current.data && types.data ? { parts: current.data, types: types.data } : undefined, isLoading: current.isLoading || types.isLoading, error: current.error ?? types.error, refetch: () => current.refetch() };
  return (
    <div className="flex flex-col gap-6">
      <QueryView query={q}>{(d) => <HardwareEditor robotId={robotId} parts={d.parts} types={d.types} />}</QueryView>
      <HardwareHistory robotId={robotId} />
    </div>
  );
}

function buildSlots(parts: HardwarePartDto[], types: PartTypeDto[], extraEncoders: number): Slot[] {
  const slots: Slot[] = [];
  const order = ['gps', 'imu', 'lidar', 'controller', 'camera', 'encoder'];
  const sorted = [...types].sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
  for (const t of sorted) {
    const mine = parts.filter((p) => p.part_type_key === t.key);
    if (t.max_per_robot === 1) {
      slots.push({ key: t.key, typeKey: t.key, label: t.name, slot: null, part: mine[0] ?? null });
    } else if (t.max_per_robot) {
      for (let s = 1; s <= t.max_per_robot; s++) slots.push({ key: `${t.key}-${s}`, typeKey: t.key, label: `${t.name} ${s}`, slot: s, part: mine.find((p) => p.slot === s) ?? null });
    } else {
      // Unlimited (encoders): every fitted one, plus empty lines the user added.
      const used = mine.map((p) => p.slot ?? 0);
      for (const p of [...mine].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))) slots.push({ key: p.id, typeKey: t.key, label: `${t.name} ${p.slot ?? ''}`.trim(), slot: p.slot, part: p });
      let next = Math.max(0, ...used) + 1;
      const wanted = Math.max(extraEncoders, mine.length ? 0 : 2);
      for (let i = 0; i < wanted; i++, next++) slots.push({ key: `${t.key}-new-${next}`, typeKey: t.key, label: `${t.name} ${next}`, slot: next, part: null });
    }
  }
  return slots;
}

function HardwareEditor({ robotId, parts, types }: { robotId: string; parts: HardwarePartDto[]; types: PartTypeDto[] }) {
  const can = useCan();
  const canWrite = can('hardware.write');
  const qc = useQueryClient();
  const toast = useToast();
  const [extraEncoders, setExtraEncoders] = useState(0);
  const slots = useMemo(() => buildSlots(parts, types, extraEncoders), [parts, types, extraEncoders]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [removing, setRemoving] = useState<HardwarePartDto | null>(null);
  const [saving, setSaving] = useState(false);

  // Saved data changed (after a save, or someone else's edit): start again from it. Untouched lines fall back
  // to the saved values, so adding an encoder line keeps edits in progress.
  useEffect(() => setDrafts({}), [parts]);

  const draft = (s: Slot) => drafts[s.key] ?? toDraft(s.part);
  const set = (s: Slot, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [s.key]: { ...draft(s), ...patch } }));
  const changed = slots.filter((s) => (s.part ? !same(draft(s), toDraft(s.part)) : filled(draft(s))));
  const invalid = changed.some((s) => urlError(draft(s).product_url) || (s.part && !draft(s).fitted_at));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed.length || invalid) return;
    setSaving(true);
    let ok = 0;
    const failed: string[] = [];
    for (const s of changed) {
      const d = draft(s);
      const body = {
        model: d.model.trim() || null,
        serial_number: d.serial_number.trim() || null,
        product_url: d.product_url.trim() || null,
      };
      try {
        if (s.part) await api.patch(`/hardware/${s.part.id}`, { ...body, fitted_at: d.fitted_at });
        else await api.post(`/robots/${robotId}/hardware`, { ...body, part_type_key: s.typeKey, slot: s.slot ?? undefined, fitted_at: d.fitted_at || todayDate() });
        ok++;
      } catch (err) {
        failed.push(`${s.label}: ${errorMessage(err)}`);
      }
    }
    setSaving(false);
    if (ok) toast.success(`${ok} part${ok === 1 ? '' : 's'} saved`);
    if (failed.length) toast.error(new Error(failed.join(' · ')));
    setExtraEncoders(0);
    await qc.invalidateQueries({ queryKey: ['robot', robotId, 'hardware'] });
  };

  if (!canWrite) return <ReadOnlyParts parts={parts} />;

  return (
    <Card
      title="Fitted hardware"
      actions={
        <span className="text-xs text-muted">
          {parts.length} fitted · edit any field and press Save
        </span>
      }
      bodyClassName="p-0"
    >
      <form onSubmit={save}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <caption className="sr-only">Fitted hardware, editable</caption>
            <thead className="bg-surface-2 text-left text-xs font-semibold tracking-wide text-muted uppercase">
              <tr>
                <th scope="col" className="px-4 py-2">
                  Part
                </th>
                <th scope="col" className="px-2 py-2">
                  Model
                </th>
                <th scope="col" className="px-2 py-2">
                  Serial number
                </th>
                <th scope="col" className="px-2 py-2">
                  Product URL
                </th>
                <th scope="col" className="px-2 py-2">
                  Fitted on
                </th>
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => {
                const d = draft(s);
                const dirty = s.part ? !same(d, toDraft(s.part)) : filled(d);
                const bad = urlError(d.product_url);
                const cell = 'h-9 text-sm';
                return (
                  <tr key={s.key} className={cn('border-t border-border align-top', dirty && 'bg-accent-soft/40', !s.part && !dirty && 'text-muted')}>
                    <th scope="row" className="px-4 py-2.5 text-left font-medium whitespace-nowrap">
                      <span className="block">{s.label}</span>
                      {s.part ? (
                        <>
                          <Badge tone="ok" className="mt-1">
                            Fitted
                          </Badge>
                          {s.part.updated_at && (
                            <span className="mt-1 block text-xs font-normal text-muted" title={fmtDateTime(s.part.updated_at)}>
                              Edited by {s.part.updated_by_name ?? 'someone'}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="mt-1 block text-xs font-normal text-muted">{dirty ? 'Will be fitted' : 'Empty'}</span>
                      )}
                    </th>
                    <td className="px-2 py-2">
                      <Input aria-label={`${s.label} model`} className={cell} value={d.model} placeholder={s.part ? '' : (MODEL_HINT[s.typeKey] ?? 'Model')} onChange={(e) => set(s, { model: e.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <Input aria-label={`${s.label} serial number`} className={cn(cell, 'font-mono')} value={d.serial_number} spellCheck={false} onChange={(e) => set(s, { serial_number: e.target.value })} />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={`${s.label} product URL`}
                          aria-invalid={bad ? true : undefined}
                          className={cn(cell, bad && 'border-fault')}
                          type="url"
                          inputMode="url"
                          placeholder="https://"
                          value={d.product_url}
                          spellCheck={false}
                          onChange={(e) => set(s, { product_url: e.target.value })}
                          title={bad ?? undefined}
                        />
                        {d.product_url && !bad && (
                          <a href={d.product_url.trim()} target="_blank" rel="noopener noreferrer" className="rounded p-1.5 text-accent-text hover:bg-surface-2" aria-label={`Open ${s.label} product page`}>
                            <ExternalLink className="size-4" aria-hidden />
                          </a>
                        )}
                      </div>
                      {bad && <p className="mt-1 text-xs text-fault">{bad}</p>}
                    </td>
                    <td className="px-2 py-2">
                      <Input aria-label={`${s.label} fitted on`} className={cell} type="date" value={d.fitted_at} max={todayDate()} onChange={(e) => set(s, { fitted_at: e.target.value })} />
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {dirty && (
                        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => setDrafts((x) => ({ ...x, [s.key]: toDraft(s.part) }))} aria-label={`Undo changes to ${s.label}`}>
                          Undo
                        </Button>
                      )}
                      {s.part && (
                        <Button size="sm" onClick={() => setRemoving(s.part)} aria-label={`Remove ${s.label}`}>
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <Button type="submit" variant="primary" loading={saving} disabled={!changed.length || invalid}>
            {changed.length ? `Save changes (${changed.length})` : 'Save changes'}
          </Button>
          {changed.length > 0 && (
            <Button onClick={() => setDrafts({})} disabled={saving}>
              Discard
            </Button>
          )}
          {types.some((t) => t.key === 'encoder') && (
            <Button variant="ghost" icon={<Plus className="size-4" aria-hidden />} onClick={() => setExtraEncoders((n) => n + 1)}>
              Add encoder
            </Button>
          )}
          <span className="text-xs text-muted">Empty slots are fitted when you fill them in (fitted date defaults to today). To change a part for a different one, Remove it first.</span>
        </div>
      </form>
      <RemovePartDialog robotId={robotId} part={removing} onClose={() => setRemoving(null)} />
    </Card>
  );
}

function ProductLink({ url }: { url: string }) {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* shown as is */
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline" title={url}>
      {host}
      <ExternalLink className="size-3.5" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** For roles that can only view hardware. */
function ReadOnlyParts({ parts }: { parts: HardwarePartDto[] }) {
  if (!parts.length) return <EmptyState title="No hardware recorded" description="The GPS module, encoders, IMU, LiDAR, cameras and controller fitted to this robot appear here." />;
  return (
    <DataTable
      caption="Fitted hardware"
      rows={parts}
      rowKey={(p) => p.id}
      columns={[
        { key: 'type', header: 'Part', rowHeader: true, cell: (p) => `${p.part_type_name}${p.slot ? ` ${p.slot}` : ''}` },
        { key: 'model', header: 'Model', cell: (p) => p.model ?? '—' },
        { key: 'serial', header: 'Serial', cell: (p) => (p.serial_number ? <Mono>{p.serial_number}</Mono> : '—') },
        { key: 'url', header: 'Product', cell: (p) => (p.product_url ? <ProductLink url={p.product_url} /> : '—') },
        { key: 'fitted', header: 'Fitted', cell: (p) => fmtDate(p.fitted_at) },
      ]}
    />
  );
}

/** Removed parts: the hardware history (read-only). */
function HardwareHistory({ robotId }: { robotId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['robot', robotId, 'hardware', true],
    queryFn: () => api.get<HardwarePartDto[]>(`/robots/${robotId}/hardware`),
    enabled: open,
  });
  const removed = (q.data ?? []).filter((p) => p.removed_at);
  return (
    <details className="group rounded-lg border border-border bg-surface" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-surface-2">
        <History className="size-4 text-muted" aria-hidden />
        Hardware history (removed parts)
        <span className="ml-auto text-xs text-muted transition-transform group-open:rotate-90" aria-hidden>
          ▸
        </span>
      </summary>
      <div className="border-t border-border p-3">
        <QueryView query={q}>
          {() =>
            removed.length === 0 ? (
              <p className="px-1 text-sm text-muted">No part has been removed from this robot yet.</p>
            ) : (
              <DataTable
                caption="Removed parts"
                dense
                rows={removed}
                rowKey={(p) => p.id}
                columns={[
                  { key: 'type', header: 'Part', rowHeader: true, cell: (p) => `${p.part_type_name}${p.slot ? ` ${p.slot}` : ''}` },
                  { key: 'model', header: 'Model', cell: (p) => p.model ?? '—' },
                  { key: 'serial', header: 'Serial', cell: (p) => (p.serial_number ? <Mono>{p.serial_number}</Mono> : '—') },
                  { key: 'fitted', header: 'Fitted', cell: (p) => fmtDate(p.fitted_at) },
                  { key: 'removed', header: 'Removed', cell: (p) => fmtDate(p.removed_at) },
                  { key: 'reason', header: 'Reason', cell: (p) => p.removal_reason ?? '' },
                ]}
              />
            )
          }
        </QueryView>
      </div>
    </details>
  );
}

function RemovePartDialog({ robotId, part, onClose }: { robotId: string; part: HardwarePartDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [removedAt, setRemovedAt] = useState(todayDate());
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<HardwarePartDto>(`/hardware/${part!.id}/remove`, { removed_at: removedAt, reason: reason.trim() || undefined }),
    onSuccess: () => {
      toast.success('Part removed (kept in history)');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'hardware'] });
      setReason('');
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!part}
      onClose={onClose}
      title={`Remove ${part?.part_type_name ?? ''}${part?.slot ? ` ${part.slot}` : ''}`}
      description="The part is marked removed with a date and stays in the hardware history. The slot becomes empty so a new part can be fitted."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!removedAt}>
            Remove part
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Removed on" required>
          <Input type="date" value={removedAt} min={part?.fitted_at} onChange={(e) => setRemovedAt(e.target.value)} data-autofocus />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
