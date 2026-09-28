'use client';

import type { HardwarePartDto, MaintenanceDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RotateCcw, Trash2, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, EmptyState, Mono, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDate, todayDate } from '@/lib/format';
import { usePartTypes } from '@/lib/queries';

/** Spec §3 row 9: one entry per repair (what, part removed/fitted serials, by whom, when). */
export function MaintenanceTab({ robotId }: { robotId: string }) {
  const can = useCan();
  const canWrite = can('maintenance.write');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<MaintenanceDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MaintenanceDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['robot', robotId, 'maintenance', includeDeleted],
    queryFn: () => api.get<MaintenanceDto[]>(`/robots/${robotId}/maintenance`, { include_deleted: includeDeleted }),
  });
  const del = useMutation({
    mutationFn: (m: MaintenanceDto) => (m.deleted_at ? api.post(`/maintenance/${m.id}/restore`) : api.del(`/maintenance/${m.id}`)),
    onSuccess: (_r, m) => {
      toast.success(m.deleted_at ? 'Repair restored' : 'Repair deleted (restorable)');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'maintenance'] });
    },
    onError: toast.error,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
        {canWrite && (
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
            Record repair
          </Button>
        )}
      </div>
      <QueryView query={q}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No repairs recorded" icon={<Wrench className="size-8" />} description="Each repair is one entry: what was repaired, part removed and fitted (serials), who repaired it and when." />
          ) : (
            <DataTable
              caption="Maintenance log"
              rows={rows}
              rowKey={(m) => m.id}
              rowClassName={(m) => (m.deleted_at ? 'opacity-60' : undefined)}
              columns={[
                { key: 'date', header: 'Date', rowHeader: true, cell: (m) => fmtDate(m.repaired_at) },
                {
                  key: 'desc',
                  header: 'What was repaired',
                  className: 'min-w-64',
                  cell: (m) => (
                    <span>
                      {m.description}
                      {m.deleted_at && <Badge tone="fault" className="ml-2">Deleted</Badge>}
                      {(m.hardware_removed_id || m.hardware_fitted_id) && <Badge tone="accent" className="ml-2">Part swapped</Badge>}
                    </span>
                  ),
                },
                { key: 'rem', header: 'Part removed', cell: (m) => (m.part_removed_serial ? <Mono>{m.part_removed_serial}</Mono> : '—') },
                { key: 'fit', header: 'Part fitted', cell: (m) => (m.part_fitted_serial ? <Mono>{m.part_fitted_serial}</Mono> : '—') },
                { key: 'by', header: 'Repaired by', cell: (m) => m.repaired_by },
                {
                  key: 'act',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  cell: (m) =>
                    canWrite ? (
                      <span className="flex justify-end gap-1">
                        {!m.deleted_at && (
                          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(m)} aria-label={`Edit repair of ${fmtDate(m.repaired_at)}`}>
                            Edit
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={m.deleted_at ? <RotateCcw className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                          onClick={() => (m.deleted_at ? del.mutate(m) : setDeleting(m))}
                          aria-label={m.deleted_at ? 'Restore repair' : 'Delete repair'}
                        >
                          {m.deleted_at ? 'Restore' : 'Delete'}
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
          )
        }
      </QueryView>
      <RepairDialog robotId={robotId} value={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        loading={del.isPending}
        danger
        title="Delete repair entry?"
        description="The entry is hidden (soft delete) and can be restored. Hardware history is not changed."
        confirmLabel="Delete"
      />
    </div>
  );
}

function RepairDialog({ robotId, value, onClose }: { robotId: string; value: MaintenanceDto | 'new' | null; onClose: () => void }) {
  const isNew = value === 'new';
  const existing = value && value !== 'new' ? value : null;
  const qc = useQueryClient();
  const toast = useToast();
  const types = usePartTypes();
  const parts = useQuery({
    queryKey: ['robot', robotId, 'hardware', false],
    queryFn: () => api.get<HardwarePartDto[]>(`/robots/${robotId}/hardware`, { current: true }),
    enabled: isNew,
  });
  const [f, setF] = useState({ repaired_at: todayDate(), description: '', repaired_by: '', part_removed_serial: '', part_fitted_serial: '' });
  const [swap, setSwap] = useState(false);
  const [removeId, setRemoveId] = useState('');
  const [newType, setNewType] = useState('');
  const [newSlot, setNewSlot] = useState('');
  const [newModel, setNewModel] = useState('');

  useEffect(() => {
    if (existing) {
      setF({
        repaired_at: existing.repaired_at,
        description: existing.description,
        repaired_by: existing.repaired_by,
        part_removed_serial: existing.part_removed_serial ?? '',
        part_fitted_serial: existing.part_fitted_serial ?? '',
      });
    } else if (isNew) {
      setF({ repaired_at: todayDate(), description: '', repaired_by: '', part_removed_serial: '', part_fitted_serial: '' });
      setSwap(false);
      setRemoveId('');
      setNewType('');
      setNewSlot('');
      setNewModel('');
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Picking the part to remove pre-fills serial, type and slot for the replacement.
  useEffect(() => {
    const p = parts.data?.find((x) => x.id === removeId);
    if (p) {
      setF((prev) => ({ ...prev, part_removed_serial: p.serial_number ?? prev.part_removed_serial }));
      setNewType(p.part_type_key);
      setNewSlot(p.slot ? String(p.slot) : '');
      setNewModel(p.model ?? '');
    }
  }, [removeId, parts.data]);

  const m = useMutation({
    mutationFn: () => {
      const body = {
        repaired_at: f.repaired_at,
        description: f.description.trim(),
        repaired_by: f.repaired_by.trim(),
        part_removed_serial: f.part_removed_serial.trim() || undefined,
        part_fitted_serial: f.part_fitted_serial.trim() || undefined,
      };
      if (existing) return api.patch<MaintenanceDto>(`/maintenance/${existing.id}`, body);
      return api.post<MaintenanceDto>(`/robots/${robotId}/maintenance`, {
        ...body,
        swap: swap && newType ? { remove_hardware_id: removeId || undefined, part_type_key: newType, slot: newSlot ? Number(newSlot) : undefined, model: newModel.trim() || undefined } : undefined,
      });
    },
    onSuccess: () => {
      toast.success(existing ? 'Repair updated' : swap ? 'Repair recorded and hardware updated' : 'Repair recorded');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'maintenance'] });
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'hardware'] });
      onClose();
    },
    onError: toast.error,
  });
  const valid = f.repaired_at && f.description.trim() && f.repaired_by.trim() && (!swap || newType);

  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={existing ? 'Edit repair' : 'Record repair'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date of repair" required>
          <Input type="date" value={f.repaired_at} max={todayDate()} onChange={(e) => setF({ ...f, repaired_at: e.target.value })} data-autofocus />
        </Field>
        <Field label="Repaired by" required hint="Name; may be an external technician.">
          <Input value={f.repaired_by} onChange={(e) => setF({ ...f, repaired_by: e.target.value })} />
        </Field>
        <Field label="What was repaired" required className="sm:col-span-2">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Part removed (serial)">
          <Input value={f.part_removed_serial} onChange={(e) => setF({ ...f, part_removed_serial: e.target.value })} spellCheck={false} />
        </Field>
        <Field label="Part fitted (serial)">
          <Input value={f.part_fitted_serial} onChange={(e) => setF({ ...f, part_fitted_serial: e.target.value })} spellCheck={false} />
        </Field>
        {isNew && (
          <fieldset className="rounded-md border border-border p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-medium">Hardware</legend>
            <Checkbox label="This repair swapped a part: update the Hardware record in the same step" checked={swap} onChange={(e) => setSwap(e.target.checked)} />
            {swap && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Part removed" className="sm:col-span-2" hint="Its fitting is closed with the repair date.">
                  <Select value={removeId} onChange={(e) => setRemoveId(e.target.value)}>
                    <option value="">None (only fitting a new part)</option>
                    {parts.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.part_type_name}
                        {p.slot ? ` ${p.slot}` : ''} · {p.model ?? 'unknown model'} · {p.serial_number ?? 'no serial'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="New part type" required>
                  <Select value={newType} onChange={(e) => setNewType(e.target.value)}>
                    <option value="">Choose…</option>
                    {types.data?.map((t) => (
                      <option key={t.id} value={t.key}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Slot">
                  <Input type="number" min={1} value={newSlot} onChange={(e) => setNewSlot(e.target.value)} />
                </Field>
                <Field label="New part model">
                  <Input value={newModel} onChange={(e) => setNewModel(e.target.value)} />
                </Field>
                <p className="self-end text-xs text-muted">The new part&apos;s serial is taken from “Part fitted (serial)”.</p>
              </div>
            )}
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
