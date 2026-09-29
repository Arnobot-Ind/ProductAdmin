'use client';

import type { SoftwareDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCcw, X } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Badge, Card, EmptyState, InlineAlert, KeyValue, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fromLocalInput, toLocalInput } from '@/lib/format';

/**
 * Spec §3 row 4: reported by the robot at boot (`hello`), or recorded here by an admin (e.g. after flashing a
 * robot that is offline). Every change is a new history row; nothing is overwritten.
 */
export function SoftwareTab({ robotId }: { robotId: string }) {
  const can = useCan();
  const [recording, setRecording] = useState(false);
  const q = useQuery({ queryKey: ['robot', robotId, 'software'], queryFn: () => api.get<SoftwareDto>(`/robots/${robotId}/software`) });
  const recordButton = can('robot.write') && (
    <Button variant="primary" icon={<RefreshCcw className="size-4" aria-hidden />} onClick={() => setRecording(true)}>
      Record update
    </Button>
  );
  return (
    <>
      <QueryView query={q}>
        {(sw) =>
          !sw.current ? (
            <EmptyState
              title="No software recorded yet"
              description="The robot reports its software and firmware versions at boot and after every reconnect. You can also record them here."
              action={recordButton || undefined}
            />
          ) : (
            <div className="flex flex-col gap-6">
              <Card title="Current" actions={recordButton || undefined}>
                <KeyValue
                  columns={3}
                  items={[
                    { label: 'Software version', value: sw.current.sw_ver ? <Mono>{sw.current.sw_ver}</Mono> : null },
                    { label: 'Firmware version', value: sw.current.fw_ver ? <Mono>{sw.current.fw_ver}</Mono> : null },
                    {
                      label: 'Last update',
                      value: (
                        <span>
                          <Time iso={sw.last_update_at} />
                          <span className="block text-xs text-muted">
                            {sw.current.source === 'manual' ? `Recorded by ${sw.current.entered_by_name ?? 'an admin'}` : 'Reported by the robot'}
                          </span>
                        </span>
                      ),
                    },
                    {
                      label: 'Enabled features',
                      value: sw.current.enabled_features?.length ? (
                        <span className="flex flex-wrap gap-1">
                          {sw.current.enabled_features.map((f) => (
                            <Badge key={f} tone="accent">
                              {f}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        'None'
                      ),
                    },
                  ]}
                />
              </Card>
              <section aria-labelledby="sw-history">
                <h2 id="sw-history" className="mb-2 text-sm font-semibold">
                  Update history
                </h2>
                <DataTable
                  caption="Software update history"
                  rows={sw.history}
                  rowKey={(h) => h.id}
                  columns={[
                    { key: 'at', header: 'When', rowHeader: true, cell: (h) => <Time iso={h.reported_at} /> },
                    { key: 'sw', header: 'Software', cell: (h) => (h.sw_ver ? <Mono>{h.sw_ver}</Mono> : '—') },
                    { key: 'fw', header: 'Firmware', cell: (h) => (h.fw_ver ? <Mono>{h.fw_ver}</Mono> : '—') },
                    { key: 'feat', header: 'Features', cell: (h) => h.enabled_features?.join(', ') || '—' },
                    {
                      key: 'src',
                      header: 'Source',
                      cell: (h) =>
                        h.source === 'manual' ? (
                          <span>
                            <Badge>Recorded by {h.entered_by_name ?? 'admin'}</Badge>
                            {h.note && <span className="mt-0.5 block text-xs text-muted">{h.note}</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">Robot{h.boot_id ? <> · boot <span className="font-mono">{h.boot_id.slice(0, 8)}</span></> : null}</span>
                        ),
                    },
                  ]}
                />
              </section>
            </div>
          )
        }
      </QueryView>
      <RecordUpdateDialog robotId={robotId} open={recording} onClose={() => setRecording(false)} current={q.data?.current ?? null} />
    </>
  );
}

function RecordUpdateDialog({ robotId, open, onClose, current }: { robotId: string; open: boolean; onClose: () => void; current: SoftwareDto['current'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sw, setSw] = useState('');
  const [fw, setFw] = useState('');
  const [features, setFeatures] = useState<string[]>([]);
  const [newFeature, setNewFeature] = useState('');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  // Start from what the robot runs now: change only what was updated.
  useEffect(() => {
    if (!open) return;
    setSw(current?.sw_ver ?? '');
    setFw(current?.fw_ver ?? '');
    setFeatures(current?.enabled_features ?? []);
    setNewFeature('');
    setWhen(toLocalInput(new Date().toISOString()));
    setNote('');
  }, [open, current]);

  const addFeature = () => {
    const f = newFeature.trim();
    if (f && !features.includes(f)) setFeatures([...features, f].sort());
    setNewFeature('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addFeature();
    }
  };
  const unchanged =
    !!current && (current.sw_ver ?? '') === sw.trim() && (current.fw_ver ?? '') === fw.trim() && JSON.stringify(current.enabled_features ?? []) === JSON.stringify([...features].sort());

  const m = useMutation({
    mutationFn: () =>
      api.post<SoftwareDto>(`/robots/${robotId}/software`, {
        sw_ver: sw.trim() || null,
        fw_ver: fw.trim() || null,
        enabled_features: newFeature.trim() && !features.includes(newFeature.trim()) ? [...features, newFeature.trim()] : features,
        updated_at: fromLocalInput(when),
        note: note.trim() || null,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['robot', robotId, 'software'], data);
      toast.success('Software update recorded');
      onClose();
    },
    onError: toast.error,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record software update"
      description="Saves the new versions and features in the PMS history. It does not install anything on the robot."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={unchanged && !newFeature.trim()}>
            Save update
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Software version" hint={current?.sw_ver ? `Now ${current.sw_ver}` : 'e.g. 2.4.1'}>
          <Input value={sw} onChange={(e) => setSw(e.target.value)} spellCheck={false} data-autofocus />
        </Field>
        <Field label="Firmware version" hint={current?.fw_ver ? `Now ${current.fw_ver}` : 'e.g. 1.9.0'}>
          <Input value={fw} onChange={(e) => setFw(e.target.value)} spellCheck={false} />
        </Field>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium" id="features-label">
            Enabled features
          </span>
          <ul className="flex min-h-9 flex-wrap items-center gap-1.5" aria-labelledby="features-label">
            {features.length === 0 && <li className="text-sm text-muted">None</li>}
            {features.map((f) => (
              <li key={f}>
                <Badge tone="accent">
                  {f}
                  <button type="button" onClick={() => setFeatures(features.filter((x) => x !== f))} className="ml-0.5 rounded hover:text-fault" aria-label={`Disable ${f}`}>
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input value={newFeature} onChange={(e) => setNewFeature(e.target.value)} onKeyDown={onKey} placeholder="Add a feature, e.g. rtk_gps" aria-label="New feature" spellCheck={false} />
            <Button icon={<Plus className="size-4" aria-hidden />} onClick={addFeature} disabled={!newFeature.trim()}>
              Add
            </Button>
          </div>
        </div>
        <Field label="Updated on" hint="When the update was installed">
          <Input type="datetime-local" value={when} max={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="Note" hint="e.g. flashed over USB at the workshop" className="sm:col-span-2">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {unchanged && !newFeature.trim() && (
          <div className="sm:col-span-2">
            <InlineAlert tone="accent">Change a version or a feature to record an update.</InlineAlert>
          </div>
        )}
      </div>
    </Dialog>
  );
}
