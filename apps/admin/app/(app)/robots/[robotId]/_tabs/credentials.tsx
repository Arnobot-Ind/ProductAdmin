'use client';

import type { CredentialKind, CredentialMetaDto, CredentialRevealDto, IngestClientDto, IngestKeyIssuedDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, Lock, Plus, RefreshCw, ShieldX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { OneTimeKey } from '@/components/domain/one-time-secret';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, Card, CopyButton, EmptyState, InlineAlert, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { CREDENTIAL_KINDS, PER_CAMERA_CREDENTIAL_KINDS } from '@/lib/schema';

export const CREDENTIAL_LABELS: Record<CredentialKind, string> = {
  cloudflare: 'Cloudflare credentials',
  camera_admin: 'Camera admin account',
  camera_operator: 'Camera operator account',
  camera_rtsp_url: 'Camera RTSP URL (with credentials)',
  ssh: 'SSH credentials',
  ssh_public_key: 'SSH public key',
  omni: 'OMNI credentials',
  wifi_router: 'Wi-Fi router credentials',
  gcs_login: 'GCS operator login (GCS_LOGIN_USER / PASS)',
  gcs_api_token: 'GCS API token (GCS_API_TOKEN, server only)',
};

const REVEAL_SECONDS = 30;
const isPerCamera = (k: CredentialKind) => PER_CAMERA_CREDENTIAL_KINDS.includes(k);

/**
 * Spec §3 row 6 / §10. Lists METADATA only. A secret is fetched only on an explicit, confirmed
 * reveal; it is kept in component state (never in the query cache) and cleared after 30 s.
 */
export function CredentialsTab({ robotId }: { robotId: string }) {
  const can = useCan();
  const canWrite = can('credential.write');
  const canReveal = can('credential.reveal');
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmReveal, setConfirmReveal] = useState<CredentialMetaDto | null>(null);
  const [revealed, setRevealed] = useState<CredentialRevealDto | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [rotating, setRotating] = useState<CredentialMetaDto | null>(null);
  const [revoking, setRevoking] = useState<CredentialMetaDto | null>(null);
  const toast = useToast();

  const q = useQuery({
    queryKey: ['robot', robotId, 'credentials', includeRevoked],
    queryFn: () => api.get<CredentialMetaDto[]>(`/robots/${robotId}/credentials`, { include_revoked: includeRevoked }),
  });

  // Direct call (not useMutation) so the plaintext never lands in TanStack's mutation cache.
  const doReveal = async (c: CredentialMetaDto) => {
    setRevealing(true);
    try {
      const r = await api.post<CredentialRevealDto>(`/credentials/${c.id}/reveal`);
      setRevealed(r);
    } catch (e) {
      toast.error(e);
    } finally {
      setRevealing(false);
      setConfirmReveal(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <InlineAlert tone="accent" title="Secrets are encrypted and kept separately">
        Credentials are stored AES-256-GCM encrypted in <Mono>robot_credentials</Mono>, with the key held outside the database. This list shows metadata only. Revealing a secret requires the
        credential.reveal permission.
      </InlineAlert>

      {revealed && <RevealPanel secret={revealed} onHide={() => setRevealed(null)} />}

      <Card
        title="Device credentials"
        actions={
          <>
            <Checkbox label="Show revoked" checked={includeRevoked} onChange={(e) => setIncludeRevoked(e.target.checked)} />
            {canWrite && (
              <Button variant="primary" size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>
                Add credential
              </Button>
            )}
          </>
        }
        bodyClassName="p-0"
      >
        <div className="p-4">
          <QueryView query={q}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title="No credentials stored" description="Cloudflare, camera, SSH, OMNI, Wi-Fi router and GCS credentials for this robot go here." icon={<Lock className="size-8" />} />
              ) : (
                <DataTable
                  caption="Device credentials (metadata only)"
                  rows={list}
                  rowKey={(c) => c.id}
                  rowClassName={(c) => (c.revoked_at ? 'opacity-60' : undefined)}
                  columns={[
                    {
                      key: 'kind',
                      header: 'Credential',
                      rowHeader: true,
                      cell: (c) => (
                        <span>
                          {CREDENTIAL_LABELS[c.kind]}
                          {c.slot ? ` · camera ${c.slot}` : ''}
                          {c.label && <span className="block text-xs text-muted">{c.label}</span>}
                        </span>
                      ),
                    },
                    { key: 'user', header: 'Username', cell: (c) => (c.username ? <Mono>{c.username}</Mono> : '—') },
                    { key: 'secret', header: 'Secret', cell: () => <span aria-label="hidden secret">••••••••</span> },
                    {
                      key: 'created',
                      header: 'Created',
                      cell: (c) => (
                        <span className="text-xs">
                          <Time iso={c.created_at} />
                          <br />
                          {c.created_by_name ?? '—'}
                          {c.rotated_from_id && ' · rotated'}
                        </span>
                      ),
                    },
                    {
                      key: 'state',
                      header: 'State',
                      cell: (c) =>
                        c.revoked_at ? (
                          <span className="text-xs">
                            <Badge tone="fault">Revoked</Badge>
                            <br />
                            <Time iso={c.revoked_at} />
                            {c.revoke_reason ? ` · ${c.revoke_reason}` : ''}
                          </span>
                        ) : (
                          <Badge tone="ok">Active</Badge>
                        ),
                    },
                    {
                      key: 'act',
                      header: <span className="sr-only">Actions</span>,
                      align: 'right',
                      cell: (c) =>
                        c.revoked_at ? null : (
                          <span className="flex justify-end gap-1">
                            {canReveal && (
                              <Button size="sm" icon={<Eye className="size-3.5" aria-hidden />} onClick={() => setConfirmReveal(c)} aria-label={`Reveal ${CREDENTIAL_LABELS[c.kind]}`}>
                                Reveal
                              </Button>
                            )}
                            {canWrite && (
                              <>
                                <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => setRotating(c)} aria-label={`Rotate ${CREDENTIAL_LABELS[c.kind]}`}>
                                  Rotate
                                </Button>
                                <Button size="sm" variant="ghost" icon={<ShieldX className="size-3.5" aria-hidden />} onClick={() => setRevoking(c)} aria-label={`Revoke ${CREDENTIAL_LABELS[c.kind]}`}>
                                  Revoke
                                </Button>
                              </>
                            )}
                          </span>
                        ),
                    },
                  ]}
                />
              )
            }
          </QueryView>
        </div>
      </Card>

      {can('ingest.manage') && <RobotIngestKeys robotId={robotId} />}

      <ConfirmDialog
        open={!!confirmReveal}
        onClose={() => setConfirmReveal(null)}
        onConfirm={() => confirmReveal && void doReveal(confirmReveal)}
        loading={revealing}
        title="Reveal secret?"
        description={`The decrypted value of "${confirmReveal ? CREDENTIAL_LABELS[confirmReveal.kind] : ''}" will be shown on screen. Make sure nobody is looking over your shoulder. It hides again after ${REVEAL_SECONDS} seconds.`}
        confirmLabel="Reveal"
      />
      <AddCredentialDialog robotId={robotId} open={adding} onClose={() => setAdding(false)} />
      <RotateDialog robotId={robotId} cred={rotating} onClose={() => setRotating(null)} />
      <RevokeDialog robotId={robotId} cred={revoking} onClose={() => setRevoking(null)} />
    </div>
  );
}

function RevealPanel({ secret, onHide }: { secret: CredentialRevealDto; onHide: () => void }) {
  const [left, setLeft] = useState(REVEAL_SECONDS);
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;
  useEffect(() => {
    setLeft(REVEAL_SECONDS);
    const id = window.setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          window.clearInterval(id);
          onHideRef.current();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [secret]);
  return (
    <section aria-label="Revealed secret" className="rounded-lg border border-warn/50 bg-warn-bg p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-warn">
          <KeyRound className="size-4" aria-hidden /> {CREDENTIAL_LABELS[secret.kind]}
        </p>
        <p className="text-xs text-fg" aria-live="off">
          Hides in {left}s
        </p>
      </div>
      {secret.username && (
        <p className="mb-2 text-sm">
          Username: <Mono>{secret.username}</Mono>
        </p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        <code className="min-w-0 flex-1 rounded bg-surface px-2 py-1.5 font-mono text-sm break-all whitespace-pre-wrap select-all">{secret.secret}</code>
        <CopyButton value={secret.secret} label="Copy secret" />
        <Button size="sm" icon={<EyeOff className="size-4" aria-hidden />} onClick={onHide}>
          Hide now
        </Button>
      </div>
    </section>
  );
}

function SecretInput({ value, onChange, kind }: { value: string; onChange: (v: string) => void; kind: CredentialKind | '' }) {
  const [show, setShow] = useState(false);
  if (kind === 'ssh_public_key' || kind === 'cloudflare') {
    return <Textarea value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />;
  }
  return (
    <div className="flex gap-2">
      <Input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" spellCheck={false} className="font-mono" />
      <Button size="md" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide secret' : 'Show secret'}>
        {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </Button>
    </div>
  );
}

function AddCredentialDialog({ robotId, open, onClose }: { robotId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<CredentialKind | ''>('');
  const [slot, setSlot] = useState('1');
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setKind('');
    setLabel('');
    setUsername('');
    setSecret('');
    setError(null);
  };
  // Direct call so the secret in the request is not retained by the mutation cache.
  const submit = async () => {
    if (!kind || !secret) return setError('Kind and secret are required');
    setBusy(true);
    try {
      await api.post<CredentialMetaDto>(`/robots/${robotId}/credentials`, {
        kind,
        slot: isPerCamera(kind) ? Number(slot) : undefined,
        label: label.trim() || undefined,
        username: username.trim() || undefined,
        secret,
      });
      toast.success('Credential stored (encrypted)');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'credentials'] });
      reset();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add credential"
      description="Encrypted before it is stored. Only one active credential per kind (and camera slot); use Rotate to replace one."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Store encrypted
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Kind" required className="sm:col-span-2">
          <Select value={kind} onChange={(e) => setKind(e.target.value as CredentialKind)} data-autofocus>
            <option value="">Choose…</option>
            {CREDENTIAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {CREDENTIAL_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        {kind && isPerCamera(kind) && (
          <Field label="Camera" required>
            <Select value={slot} onChange={(e) => setSlot(e.target.value)}>
              {[1, 2, 3, 4].map((s) => (
                <option key={s} value={s}>
                  Camera {s}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Username" hint="Not secret; shown in the list.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </Field>
        <Field label={kind === 'camera_rtsp_url' ? 'RTSP URL with credentials' : kind === 'gcs_api_token' ? 'Token' : 'Secret / password'} required className="sm:col-span-2">
          <SecretInput value={secret} onChange={setSecret} kind={kind} />
        </Field>
        {error && (
          <p role="alert" className="text-sm font-medium text-fault sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function RotateDialog({ robotId, cred, onClose }: { robotId: string; cred: CredentialMetaDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setUsername(cred?.username ?? '');
    setSecret('');
  }, [cred]);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post<CredentialMetaDto>(`/credentials/${cred!.id}/rotate`, { secret, username: username.trim() || undefined });
      toast.success('Credential rotated: old value revoked, new value stored');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'credentials'] });
      setSecret('');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!cred}
      onClose={onClose}
      title={`Rotate ${cred ? CREDENTIAL_LABELS[cred.kind] : ''}`}
      description="Rotate when an employee with access leaves or the robot returns from outside Arnobot. The old value is revoked and kept for the record."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!secret}>
            Rotate
          </Button>
        </>
      }
    >
      <form className="grid gap-4" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} data-autofocus />
        </Field>
        <Field label="New secret" required>
          <SecretInput value={secret} onChange={setSecret} kind={cred?.kind ?? ''} />
        </Field>
      </form>
    </Dialog>
  );
}

function RevokeDialog({ robotId, cred, onClose }: { robotId: string; cred: CredentialMetaDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<CredentialMetaDto>(`/credentials/${cred!.id}/revoke`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success('Credential revoked');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'credentials'] });
      setReason('');
      onClose();
    },
    onError: toast.error,
  });
  return (
    <ConfirmDialog
      open={!!cred}
      onClose={onClose}
      onConfirm={() => reason.trim() && m.mutate()}
      loading={m.isPending}
      danger
      title={`Revoke ${cred ? CREDENTIAL_LABELS[cred.kind] : ''}?`}
      description="Use this when a credential is lost or stolen. The record is kept but marked revoked."
      confirmLabel="Revoke"
    >
      <Field label="Reason" required>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}

/** How this robot (or its GCS) authenticates TO the PMS ingest endpoint. Keys are shown once. */
function RobotIngestKeys({ robotId }: { robotId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [issued, setIssued] = useState<IngestKeyIssuedDto | null>(null);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['ingest-clients', { robot_id: robotId }], queryFn: () => api.get<IngestClientDto[]>('/ingest-clients', { robot_id: robotId }) });
  const newKey = useMutation({
    mutationFn: (clientId: string) => api.post<IngestKeyIssuedDto>(`/ingest-clients/${clientId}/keys`),
    onSuccess: (r) => {
      setIssued(r);
      void qc.invalidateQueries({ queryKey: ['ingest-clients'] });
    },
    onError: toast.error,
    gcTime: 0,
  });
  const revokeKey = useMutation({
    mutationFn: (keyId: string) => api.post<IngestClientDto>(`/ingest-keys/${keyId}/revoke`),
    onSuccess: () => {
      toast.success('Key revoked: it stops working within seconds');
      setRevokingKey(null);
      void qc.invalidateQueries({ queryKey: ['ingest-clients'] });
    },
    onError: toast.error,
  });

  return (
    <Card title="Ingest keys (robot / GCS → PMS)">
      <QueryView query={q}>
        {(clients) =>
          clients.length === 0 ? (
            <p className="text-sm text-muted">No ingest client can send data for this robot.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {clients.map((c) => (
                <div key={c.id} className="rounded-md border border-border p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {c.name} <Badge tone={c.kind === 'gcs' ? 'accent' : 'neutral'}>{c.kind === 'gcs' ? 'GCS' : 'Robot'}</Badge>
                      {c.revoked_at && <Badge tone="fault" className="ml-1">Client revoked</Badge>}
                    </p>
                    {!c.revoked_at && (
                      <Button size="sm" icon={<KeyRound className="size-3.5" aria-hidden />} onClick={() => newKey.mutate(c.id)} loading={newKey.isPending && newKey.variables === c.id}>
                        Issue new key
                      </Button>
                    )}
                  </div>
                  <DataTable
                    caption={`Keys of ${c.name}`}
                    dense
                    rows={c.keys}
                    rowKey={(k) => k.id}
                    rowClassName={(k) => (k.revoked_at ? 'opacity-60' : undefined)}
                    columns={[
                      { key: 'p', header: 'Key', rowHeader: true, cell: (k) => <Mono>{k.key_prefix}…</Mono> },
                      { key: 'c', header: 'Created', cell: (k) => <Time iso={k.created_at} /> },
                      { key: 'u', header: 'Last used', cell: (k) => <Time iso={k.last_used_at} relative /> },
                      { key: 's', header: 'State', cell: (k) => (k.revoked_at ? <Badge tone="fault">Revoked</Badge> : <Badge tone="ok">Active</Badge>) },
                      {
                        key: 'a',
                        header: <span className="sr-only">Actions</span>,
                        align: 'right',
                        cell: (k) =>
                          k.revoked_at ? null : (
                            <Button size="sm" variant="ghost" onClick={() => setRevokingKey(k.id)} aria-label={`Revoke key ${k.key_prefix}`}>
                              Revoke
                            </Button>
                          ),
                      },
                    ]}
                  />
                </div>
              ))}
              <p className="text-xs text-muted">Rotate without downtime: issue a new key, install it on the robot/GCS, then revoke the old one.</p>
            </div>
          )
        }
      </QueryView>
      <Dialog open={!!issued} onClose={() => setIssued(null)} title={`New key for ${issued?.client.name ?? ''}`} footer={<Button variant="primary" onClick={() => setIssued(null)}>I have stored the key</Button>}>
        {issued && <OneTimeKey value={issued.key} />}
      </Dialog>
      <ConfirmDialog
        open={!!revokingKey}
        onClose={() => setRevokingKey(null)}
        onConfirm={() => revokingKey && revokeKey.mutate(revokingKey)}
        loading={revokeKey.isPending}
        danger
        title="Revoke this ingest key?"
        description="Anything still using it will be refused (401) within about 10 seconds."
        confirmLabel="Revoke key"
      />
    </Card>
  );
}
