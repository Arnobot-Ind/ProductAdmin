'use client';

import type { CredentialKind, CredentialMetaDto, CredentialRevealDto, IngestClientDto, IngestKeyIssuedDto, SshAuthMethod } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, KeyRound, Lock, Plus, RefreshCw, ShieldX, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { OneTimeKey } from '@/components/domain/one-time-secret';
import { REVEAL_SECONDS, RevealPanel, SecretInput } from '@/components/domain/secret';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Badge, Card, CopyButton, EmptyState, InlineAlert, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { CREDENTIAL_KINDS, PER_CAMERA_CREDENTIAL_KINDS, SSH_AUTH_METHODS } from '@/lib/schema';

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

const isPerCamera = (k: CredentialKind) => PER_CAMERA_CREDENTIAL_KINDS.includes(k);
const isMultiline = (k: CredentialKind | '') => k === 'ssh_public_key' || k === 'cloudflare';

/**
 * Spec §3 row 6 / §10. Lists METADATA only. A secret is fetched only on an explicit, confirmed
 * reveal; it is kept in component state (never in the query cache) and cleared after 30 s.
 */
/** SSH credentials have their own view (Software → SSH access); this one lists every other kind. */
export const SSH_KINDS: CredentialKind[] = ['ssh', 'ssh_public_key'];

export function CredentialsTab({ robotId, only = 'other' }: { robotId: string; only?: 'ssh' | 'other' }) {
  if (only === 'ssh') return <SshAccess robotId={robotId} />;
  return <OtherCredentials robotId={robotId} />;
}

function OtherCredentials({ robotId }: { robotId: string }) {
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

      {revealed && <RevealPanel title={CREDENTIAL_LABELS[revealed.kind]} username={revealed.username} secret={revealed.secret} onHide={() => setRevealed(null)} />}

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
            {(all) => {
              const list = all.filter((c) => !SSH_KINDS.includes(c.kind));
              return list.length === 0 ? (
                <EmptyState title="No credentials stored" description="Cloudflare, camera, OMNI, Wi-Fi router and GCS credentials for this robot go here. SSH has its own view." icon={<Lock className="size-8" />} />
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
              );
            }}
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

/** The command that opens the session: port, key file and the jump host or proxy command when there is one. */
export function sshCommand(c: { host: string | null; port: number | null; username: string | null; auth_method: string | null; proxy: string | null }, robotId: string): string {
  const parts = ['ssh'];
  if (c.port && c.port !== 22) parts.push(`-p ${c.port}`);
  if (c.auth_method === 'private_key') parts.push(`-i ~/.ssh/${robotId}_key`);
  if (c.proxy) parts.push(/\s/.test(c.proxy) ? `-o ProxyCommand="${c.proxy.replace(/"/g, '\\"')}"` : `-J ${c.proxy}`);
  parts.push(`${c.username ? `${c.username}@` : ''}${c.host ?? '<host>'}`);
  return parts.join(' ');
}

const AUTH_LABEL: Record<string, string> = { password: 'Password', private_key: 'Private key' };

/**
 * Software → SSH access: everything needed to log in to the robot. Host, port, user, how to authenticate and
 * the jump host / proxy are shown openly with a ready-to-copy command; the password or private key stays encrypted
 * and is revealed only on request (credential.reveal, audited). The robot's SSH public key is listed below.
 */
function SshAccess({ robotId }: { robotId: string }) {
  const can = useCan();
  const canWrite = can('credential.write');
  const canReveal = can('credential.reveal');
  const toast = useToast();
  const [adding, setAdding] = useState<'ssh' | 'ssh_public_key' | null>(null);
  const [confirmReveal, setConfirmReveal] = useState<CredentialMetaDto | null>(null);
  const [revealed, setRevealed] = useState<CredentialRevealDto | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [rotating, setRotating] = useState<CredentialMetaDto | null>(null);
  const [revoking, setRevoking] = useState<CredentialMetaDto | null>(null);
  const q = useQuery({
    queryKey: ['robot', robotId, 'credentials', false],
    queryFn: () => api.get<CredentialMetaDto[]>(`/robots/${robotId}/credentials`, { include_revoked: false }),
  });
  const doReveal = async (c: CredentialMetaDto) => {
    setRevealing(true);
    try {
      setRevealed(await api.post<CredentialRevealDto>(`/credentials/${c.id}/reveal`));
    } catch (e) {
      toast.error(e);
    } finally {
      setRevealing(false);
      setConfirmReveal(null);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      {revealed && (
        <RevealPanel
          title={revealed.kind === 'ssh' ? `SSH ${revealed.auth_method === 'private_key' ? 'private key' : 'password'}` : CREDENTIAL_LABELS[revealed.kind]}
          username={revealed.username}
          secret={revealed.secret}
          onHide={() => setRevealed(null)}
        />
      )}
      <QueryView query={q}>
        {(all) => {
          const logins = all.filter((c) => c.kind === 'ssh');
          const keys = all.filter((c) => c.kind === 'ssh_public_key');
          return (
            <>
              {logins.length === 0 ? (
                <EmptyState
                  icon={<Terminal className="size-8" />}
                  title="No SSH access recorded"
                  description="Store the host, port, user and password or private key used to log in to this robot. The password or key is encrypted."
                  action={
                    canWrite ? (
                      <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding('ssh')}>
                        Add SSH access
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                logins.map((c) => (
                  <Card
                    key={c.id}
                    title={
                      <span className="flex items-center gap-2">
                        <Terminal className="size-5 text-accent-text" aria-hidden /> SSH access{c.label ? ` · ${c.label}` : ''}
                      </span>
                    }
                    actions={
                      <span className="flex flex-wrap justify-end gap-1">
                        {canReveal && (
                          <Button size="sm" icon={<Eye className="size-3.5" aria-hidden />} onClick={() => setConfirmReveal(c)}>
                            Reveal {c.auth_method === 'private_key' ? 'key' : 'password'}
                          </Button>
                        )}
                        {canWrite && (
                          <>
                            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => setRotating(c)}>
                              Change
                            </Button>
                            <Button size="sm" variant="ghost" icon={<ShieldX className="size-3.5" aria-hidden />} onClick={() => setRevoking(c)}>
                              Revoke
                            </Button>
                          </>
                        )}
                      </span>
                    }
                  >
                    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                      <SshFact label="Host">{c.host ? <Mono>{c.host}</Mono> : '—'}</SshFact>
                      <SshFact label="Port">
                        <Mono>{c.port ?? 22}</Mono>
                      </SshFact>
                      <SshFact label="Username">{c.username ? <Mono>{c.username}</Mono> : '—'}</SshFact>
                      <SshFact label="Sign in with">{AUTH_LABEL[c.auth_method ?? 'password']}</SshFact>
                      <SshFact label="Jump host / proxy">{c.proxy ? <Mono>{c.proxy}</Mono> : 'Direct connection'}</SshFact>
                      <SshFact label="Stored">
                        <Time iso={c.created_at} /> · {c.created_by_name ?? '—'}
                        {c.rotated_from_id ? ' · changed' : ''}
                      </SshFact>
                    </dl>
                    <div className="mt-5">
                      <p className="mb-1.5 text-sm font-medium text-muted">Connect from a terminal</p>
                      <div className="flex flex-wrap items-start gap-2">
                        <code className="min-w-0 flex-1 rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm break-all select-all">{sshCommand(c, robotId)}</code>
                        <CopyButton value={sshCommand(c, robotId)} label="Copy command" />
                      </div>
                      {c.auth_method === 'private_key' && <p className="mt-1.5 text-sm text-muted">Save the revealed private key as ~/.ssh/{robotId}_key and run chmod 600 on it first.</p>}
                    </div>
                  </Card>
                ))
              )}

              <Card
                title="SSH public key"
                actions={
                  canWrite && keys.length === 0 ? (
                    <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding('ssh_public_key')}>
                      Add public key
                    </Button>
                  ) : undefined
                }
              >
                {keys.length === 0 ? (
                  <p className="text-base text-muted">No public key stored. Add the robot&apos;s host key or the key that is authorised on it.</p>
                ) : (
                  keys.map((k) => (
                    <div key={k.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-base">
                        {k.label ?? 'Public key'} · stored <Time iso={k.created_at} />
                      </span>
                      <span className="flex gap-1">
                        {canReveal && (
                          <Button size="sm" icon={<Eye className="size-3.5" aria-hidden />} onClick={() => setConfirmReveal(k)}>
                            Show
                          </Button>
                        )}
                        {canWrite && (
                          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => setRotating(k)}>
                            Replace
                          </Button>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </Card>
              {canWrite && logins.length > 0 && (
                <p className="text-sm text-muted">
                  One SSH login is stored per robot. Use Change to update its host, port, user or password; the old one is kept, revoked, for the record.
                </p>
              )}
            </>
          );
        }}
      </QueryView>

      <ConfirmDialog
        open={!!confirmReveal}
        onClose={() => setConfirmReveal(null)}
        onConfirm={() => confirmReveal && void doReveal(confirmReveal)}
        loading={revealing}
        title="Reveal secret?"
        description={`The decrypted value will be shown on screen and the reveal is written to the audit log. It hides again after ${REVEAL_SECONDS} seconds.`}
        confirmLabel="Reveal"
      />
      {adding === 'ssh' && <SshDialog robotId={robotId} onClose={() => setAdding(null)} />}
      <AddCredentialDialog robotId={robotId} open={adding === 'ssh_public_key'} onClose={() => setAdding(null)} fixedKind="ssh_public_key" />
      {rotating?.kind === 'ssh' ? <SshDialog robotId={robotId} replacing={rotating} onClose={() => setRotating(null)} /> : <RotateDialog robotId={robotId} cred={rotating} onClose={() => setRotating(null)} />}
      <RevokeDialog robotId={robotId} cred={revoking} onClose={() => setRevoking(null)} />
    </div>
  );
}

function SshFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-0.5 text-base break-words">{children}</dd>
    </div>
  );
}

/** Add SSH access, or change it (a rotation: the old login is revoked and kept). */
function SshDialog({ robotId, replacing, onClose }: { robotId: string; replacing?: CredentialMetaDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    host: replacing?.host ?? '',
    port: String(replacing?.port ?? 22),
    username: replacing?.username ?? '',
    auth_method: (replacing?.auth_method ?? 'password') as SshAuthMethod,
    proxy: replacing?.proxy ?? '',
    label: replacing?.label ?? '',
    secret: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const portBad = !/^\d+$/.test(f.port) || Number(f.port) < 1 || Number(f.port) > 65535;
  const submit = async () => {
    if (!f.host.trim() || !f.username.trim() || !f.secret) return setError('Host, username and the password or key are required');
    if (portBad) return setError('Port is a number from 1 to 65535');
    setBusy(true);
    try {
      const body = { host: f.host.trim(), port: Number(f.port), username: f.username.trim(), auth_method: f.auth_method, proxy: f.proxy.trim() || null, label: f.label.trim() || null, secret: f.secret };
      if (replacing) await api.post<CredentialMetaDto>(`/credentials/${replacing.id}/rotate`, body);
      else await api.post<CredentialMetaDto>(`/robots/${robotId}/credentials`, { ...body, kind: 'ssh' });
      toast.success(replacing ? 'SSH access changed: the old login is revoked and kept' : 'SSH access stored (password or key encrypted)');
      void qc.invalidateQueries({ queryKey: ['robot', robotId, 'credentials'] });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={replacing ? 'Change SSH access' : 'Add SSH access'}
      description="Host, port, user and proxy are shown to people who may see credentials. The password or private key is encrypted and only shown on Reveal."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            {replacing ? 'Save new login' : 'Store encrypted'}
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Host" required hint="IP address or host name, e.g. 192.168.1.40 or saibya02.arnobot.in">
          <Input value={f.host} onChange={(e) => set({ host: e.target.value })} spellCheck={false} className="font-mono" data-autofocus />
        </Field>
        <Field label="Port" required error={f.port && portBad ? '1–65535' : null}>
          <Input value={f.port} onChange={(e) => set({ port: e.target.value })} inputMode="numeric" className="font-mono" />
        </Field>
        <Field label="Username" required>
          <Input value={f.username} onChange={(e) => set({ username: e.target.value })} spellCheck={false} autoComplete="off" className="font-mono" />
        </Field>
        <Field label="Sign in with" required>
          <Select value={f.auth_method} onChange={(e) => set({ auth_method: e.target.value as SshAuthMethod })}>
            {SSH_AUTH_METHODS.map((m) => (
              <option key={m} value={m}>
                {AUTH_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={f.auth_method === 'private_key' ? 'Private key' : 'Password'} required className="sm:col-span-2" hint={f.auth_method === 'private_key' ? 'Paste the whole key, from -----BEGIN … to -----END …' : undefined}>
          <SecretInput value={f.secret} onChange={(v) => set({ secret: v })} multiline={f.auth_method === 'private_key'} />
        </Field>
        <Field label="Jump host or proxy command" className="sm:col-span-2" hint="Optional. A jump host (user@gateway) or a proxy command, e.g. cloudflared access ssh --hostname %h">
          <Input value={f.proxy} onChange={(e) => set({ proxy: e.target.value })} spellCheck={false} className="font-mono" />
        </Field>
        <Field label="Label" className="sm:col-span-2" hint="Optional, e.g. Jetson, field laptop">
          <Input value={f.label} onChange={(e) => set({ label: e.target.value })} />
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

function AddCredentialDialog({ robotId, open, onClose, fixedKind }: { robotId: string; open: boolean; onClose: () => void; fixedKind?: CredentialKind }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<CredentialKind | ''>(fixedKind ?? '');
  const [slot, setSlot] = useState('1');
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setKind(fixedKind ?? '');
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
            {CREDENTIAL_KINDS.filter((k) => (fixedKind ? k === fixedKind : !SSH_KINDS.includes(k))).map((k) => (
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
          <SecretInput value={secret} onChange={setSecret} multiline={isMultiline(kind)} />
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
          <SecretInput value={secret} onChange={setSecret} multiline={isMultiline(cred?.kind ?? '')} />
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
