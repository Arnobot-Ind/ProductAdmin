'use client';

import type { HardwarePartDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, EmptyState, Mono, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fmtDate, todayDate } from '@/lib/format';
import { usePartTypes } from '@/lib/queries';

/** Spec §3 row 3: one entry per part; fitting and removal are history, never overwritten. */
export function HardwareTab({ robotId }: { robotId: string }) {
  const can = useCan();
  const [showHistory, setShowHistory] = useState(false);
  const [fitting, setFitting] = useState(false);
  const [removing, setRemoving] = useState<HardwarePartDto | null>(null);
  const q = useQuery({
    queryKey: ['robot', robotId, 'hardware', showHistory],
    queryFn: () => api.get<HardwarePartDto[]>(`/robots/${robotId}/hardware`, { current: showHistory ? undefined : true }),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Checkbox label="Include removed parts (full history)" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
        {can('hardware.write') && (
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setFitting(true)}>
            Fit part
          </Button>
        )}
      </div>
      <QueryView query={q}>
        {(parts) =>
          parts.length === 0 ? (
            <EmptyState title="No hardware recorded" description="Record the GPS module, encoders, IMU, LiDAR, cameras 1–4 and controller fitted to this robot." />
          ) : (
            <DataTable
              caption="Hardware fitted"
              rows={parts}
              rowKey={(p) => p.id}
              rowClassName={(p) => (p.removed_at ? 'opacity-60' : undefined)}
              columns={[
                { key: 'type', header: 'Part', rowHeader: true, cell: (p) => `${p.part_type_name}${p.slot ? ` ${p.slot}` : ''}` },
                { key: 'model', header: 'Model', cell: (p) => p.model ?? '—' },
                { key: 'serial', header: 'Serial', cell: (p) => (p.serial_number ? <Mono>{p.serial_number}</Mono> : '—') },
                { key: 'fitted', header: 'Fitted', cell: (p) => fmtDate(p.fitted_at) },
                {
                  key: 'state',
                  header: 'State',
                  cell: (p) =>
                    p.removed_at ? (
                      <span>
                        <Badge tone="offline">Removed {fmtDate(p.removed_at)}</Badge>
                        {p.removal_reason && <span className="ml-2 text-xs text-muted">{p.removal_reason}</span>}
                      </span>
                    ) : (
                      <Badge tone="ok">Fitted</Badge>
                    ),
                },
                { key: 'notes', header: 'Notes', cell: (p) => p.notes ?? '' },
                {
                  key: 'act',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  cell: (p) =>
                    !p.removed_at && can('hardware.write') ? (
                      <Button size="sm" onClick={() => setRemoving(p)} aria-label={`Remove ${p.part_type_name}${p.slot ? ` ${p.slot}` : ''}`}>
                        Remove
                      </Button>
                    ) : null,
                },
              ]}
            />
          )
        }
      </QueryView>
      <FitPartDialog robotId={robotId} open={fitting} onClose={() => setFitting(false)} />
      <RemovePartDialog robotId={robotId} part={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

function FitPartDialog({ robotId, open, onClose }: { robotId: string; open: boolean; onClose: () => void }) {
  const types = usePartTypes();
  const qc = useQueryClient();
  const toast = useToast();
  const [partType, setPartType] = useState('');
  const [slot, setSlot] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [fittedAt, setFittedAt] = useState(todayDate());
  const [notes, setNotes] = useState('');
  const selected = types.data?.find((t) => t.key === partType);
  const needsSlot = !!selected && (selected.max_per_robot === null || selected.max_per_robot > 1);

  const m = useMutation({
    mutationFn: () =>
      api.post<HardwarePartDto>(`/robots/${robotId}/hardware`, {
        part_type_key: partType,
        slot: slot ? Number(slot) : undefined,
        model: model.trim() || undefined,
        serial_number: serial.trim() || undefined,
        fitted_at: fittedAt,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Part fitted');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'hardware'] });
      setModel('');
      setSerial('');
      setNotes('');
      setSlot('');
      onClose();
    },
    onError: toast.error,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Fit part"
      description="Only one current part per type and slot. Remove the old part first, or record a repair with a part swap under Maintenance."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!partType || !fittedAt || (needsSlot && !slot)}>
            Fit part
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Part type" required>
          <Select value={partType} onChange={(e) => setPartType(e.target.value)} data-autofocus>
            <option value="">Choose…</option>
            {types.data?.map((t) => (
              <option key={t.id} value={t.key}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Slot" required={needsSlot} hint={selected?.max_per_robot ? `1–${selected.max_per_robot}` : 'e.g. camera 1–4, encoder index'}>
          <Input type="number" min={1} max={selected?.max_per_robot ?? undefined} value={slot} onChange={(e) => setSlot(e.target.value)} disabled={!needsSlot} />
        </Field>
        <Field label="Model" hint="e.g. M9N, RTK">
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <Field label="Serial number">
          <Input value={serial} onChange={(e) => setSerial(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Fitted on" required>
          <Input type="date" value={fittedAt} onChange={(e) => setFittedAt(e.target.value)} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
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
      description="The fitting is closed with a removal date; the record stays in the hardware history."
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
