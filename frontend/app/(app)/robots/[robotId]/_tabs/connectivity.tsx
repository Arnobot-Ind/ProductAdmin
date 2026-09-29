'use client';

import type { CameraDto, ConnectivityDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, InlineAlert, KeyValue, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';

const FIELDS = [
  ['network_address', 'Network address', 'e.g. 192.168.11.0/24'],
  ['ssh_ip', 'SSH IP', 'IPv4 or IPv6'],
  ['cloudflare_tunnel_hostname', 'Cloudflare Tunnel hostname', 'e.g. api-saibya02.example.com'],
  ['omni_ip', 'OMNI IP address', ''],
  ['wifi_router_ip', 'Wi-Fi router IP address', ''],
  ['gcs_camera_domain', 'GCS camera domain', 'NEXT_PUBLIC_CAMERA_DOMAIN on this robot’s GCS'],
  ['gcs_server_domain', 'GCS server domain', 'NEXT_PUBLIC_SERVER_DOMAIN on this robot’s GCS'],
] as const;
type FieldKey = (typeof FIELDS)[number][0];

/** Rule 11: URLs in normal tables never carry user:password. */
const hasCredentials = (url: string) => /:\/\/[^/@]*@/.test(url);

/** Spec §3 row 5 (admin-entered, non-secret). Secrets live in the Credentials tab. */
export function ConnectivityTab({ robotId }: { robotId: string }) {
  const q = useQuery({ queryKey: ['robot', robotId, 'connectivity'], queryFn: () => api.get<ConnectivityDto>(`/robots/${robotId}/connectivity`) });
  return <QueryView query={q}>{(c) => <ConnectivityView c={c} robotId={robotId} />}</QueryView>;
}

function ConnectivityView({ c, robotId }: { c: ConnectivityDto; robotId: string }) {
  const can = useCan();
  const canWrite = can('robot.write');
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Record<FieldKey, string>>(() => Object.fromEntries(FIELDS.map(([k]) => [k, c[k] ?? ''])) as Record<FieldKey, string>);
  const [editingCam, setEditingCam] = useState<number | null>(null);
  useEffect(() => {
    setForm(Object.fromEntries(FIELDS.map(([k]) => [k, c[k] ?? ''])) as Record<FieldKey, string>);
  }, [c]);

  const save = useMutation({
    mutationFn: () => api.put<ConnectivityDto>(`/robots/${robotId}/connectivity`, Object.fromEntries(FIELDS.map(([k]) => [k, form[k].trim() || null]))),
    onSuccess: () => {
      toast.success('Connectivity saved');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'connectivity'] });
    },
    onError: toast.error,
  });

  const adminValues = new Set(FIELDS.map(([k]) => (c[k] ?? '').toLowerCase()).filter(Boolean));
  const reported = Object.entries(c.reported_ips ?? {});
  const domainError = (['gcs_camera_domain', 'gcs_server_domain'] as const).find((k) => hasCredentials(form[k]));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (domainError) return;
    save.mutate();
  };

  const cameras: CameraDto[] = [1, 2, 3, 4].map((slot) => c.cameras.find((x) => x.slot === slot) ?? { slot, ip: null, stream_url: null, model: null });

  return (
    <div className="flex flex-col gap-6">
      <Card title="Network">
        {canWrite ? (
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map(([k, label, hint]) => (
              <Field key={k} label={label} hint={hint || undefined} error={(k === 'gcs_camera_domain' || k === 'gcs_server_domain') && hasCredentials(form[k]) ? 'Must not contain user:password' : null}>
                <Input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} spellCheck={false} autoComplete="off" />
              </Field>
            ))}
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!!domainError}>
                Save connectivity
              </Button>
              {c.updated_at && (
                <span className="text-xs text-muted">
                  Last changed <Time iso={c.updated_at} />
                </span>
              )}
            </div>
          </form>
        ) : (
          <KeyValue items={FIELDS.map(([k, label]) => ({ label, value: c[k] ? <Mono>{c[k]}</Mono> : null }))} />
        )}
      </Card>

      <Card title="Reported by the robot (last hello)">
        {reported.length === 0 ? (
          <p className="text-sm text-muted">The robot has not reported any addresses yet.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">
              Reported <Time iso={c.reported_at} />. Shown for comparison; reported values never overwrite the admin-entered ones above.
            </p>
            <DataTable
              caption="Addresses reported by the robot"
              dense
              rows={reported}
              rowKey={([k]) => k}
              columns={[
                { key: 'k', header: 'Interface', rowHeader: true, cell: ([k]) => k },
                { key: 'v', header: 'Reported value', cell: ([, v]) => <Mono>{v}</Mono> },
                {
                  key: 'm',
                  header: 'Compared with admin values',
                  cell: ([, v]) => (adminValues.has(v.toLowerCase()) ? <Badge tone="ok">Matches</Badge> : <Badge tone="warn">Differs / not entered</Badge>),
                },
              ]}
            />
          </>
        )}
      </Card>

      <Card title="Cameras" bodyClassName="p-0">
        <div className="px-4 pt-3">
          <InlineAlert tone="accent">Stream URLs here never contain a username or password. Camera logins and RTSP URLs with credentials belong in the Credentials tab (encrypted).</InlineAlert>
        </div>
        <div className="p-4">
          <DataTable
            caption="Cameras"
            rows={cameras}
            rowKey={(cam) => String(cam.slot)}
            columns={[
              { key: 'slot', header: 'Camera', rowHeader: true, cell: (cam) => `Camera ${cam.slot}` },
              { key: 'ip', header: 'IP address', cell: (cam) => (cam.ip ? <Mono>{cam.ip}</Mono> : '—') },
              { key: 'url', header: 'Stream URL', cell: (cam) => (cam.stream_url ? <Mono className="break-all">{cam.stream_url}</Mono> : '—') },
              { key: 'model', header: 'Model', cell: (cam) => cam.model ?? '—' },
              {
                key: 'act',
                header: <span className="sr-only">Actions</span>,
                align: 'right',
                cell: (cam) =>
                  canWrite ? (
                    <Button size="sm" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditingCam(cam.slot)} aria-label={`Edit camera ${cam.slot}`}>
                      Edit
                    </Button>
                  ) : null,
              },
            ]}
          />
        </div>
      </Card>
      <CameraDialog robotId={robotId} camera={editingCam ? cameras[editingCam - 1] : null} onClose={() => setEditingCam(null)} />
    </div>
  );
}

function CameraDialog({ robotId, camera, onClose }: { robotId: string; camera: CameraDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ip, setIp] = useState('');
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  useEffect(() => {
    setIp(camera?.ip ?? '');
    setUrl(camera?.stream_url ?? '');
    setModel(camera?.model ?? '');
  }, [camera]);
  const bad = hasCredentials(url);
  const m = useMutation({
    mutationFn: () => api.put<ConnectivityDto>(`/robots/${robotId}/cameras/${camera!.slot}`, { ip: ip.trim() || null, stream_url: url.trim() || null, model: model.trim() || null }),
    onSuccess: () => {
      toast.success(`Camera ${camera?.slot} saved`);
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'connectivity'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!camera}
      onClose={onClose}
      title={`Camera ${camera?.slot ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={bad}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="IP address">
          <Input value={ip} onChange={(e) => setIp(e.target.value)} data-autofocus spellCheck={false} />
        </Field>
        <Field label="Stream URL" hint="Without username or password, e.g. rtsp://192.168.1.101:554/stream1" error={bad ? 'Remove the user:password part. Store the RTSP URL with credentials as an encrypted credential instead.' : null}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Model">
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
