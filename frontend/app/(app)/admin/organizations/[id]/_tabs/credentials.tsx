'use client';

import type { ClientCredentialDto, ClientCredentialKind, ClientCredentialRevealDto, OrganizationDetailDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Lock, Plus, RefreshCw, ShieldX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { REVEAL_SECONDS, RevealPanel, SecretInput } from '@/components/domain/secret';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, Card, EmptyState, InlineAlert, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { CLIENT_CREDENTIAL_KINDS } from '@/lib/schema';

const KIND_LABELS: Record<ClientCredentialKind, string> = {
  gcs_login: 'GCS login',
  gcs_api_token: 'GCS API token',
  portal: 'Client portal account',
  camera: 'Camera account',
  wifi: 'Wi-Fi',
  vpn: 'VPN',
  cloud: 'Cloud account',
  email: 'Email account',
  other: 'Other',
};

/**
 * Secrets Arnobot holds for this client (GCS logins, Wi-Fi, VPN …). Lists metadata only; a secret is fetched only on
 * an explicit, confirmed reveal, kept in component state (never the query cache) and hidden again after 30 s.
 */
export function ClientCredentialsTab({ org }: { org: OrganizationDetailDto }) {
  const can = useCan();
  const toast = useToast();
  const canWrite = can('credential.write') && !org.deleted_at;
  const canReveal = can('credential.reveal');
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmReveal, setConfirmReveal] = useState<ClientCredentialDto | null>(null);
  const [revealed, setRevealed] = useState<ClientCredentialRevealDto | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [rotating, setRotating] = useState<ClientCredentialDto | null>(null);
  const [revoking, setRevoking] = useState<ClientCredentialDto | null>(null);
  const q = useQuery({
    queryKey: ['organizations', org.id, 'credentials', includeRevoked],
    queryFn: () => api.get<ClientCredentialDto[]>(`/organizations/${org.id}/credentials`, { include_revoked: includeRevoked }),
  });

  // Direct call (not useMutation) so the plaintext never lands in TanStack's mutation cache.
  const doReveal = async (c: ClientCredentialDto) => {
    setRevealing(true);
    try {
      setRevealed(await api.post<ClientCredentialRevealDto>(`/client-credentials/${c.id}/reveal`));
    } catch (e) {
      toast.error(e);
    } finally {
      setRevealing(false);
      setConfirmReveal(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <InlineAlert tone="accent" title="Encrypted, and never shown to the client">
        Stored AES-256-GCM encrypted with the key held outside the database. Every reveal is recorded in the audit log. Robot secrets stay on each robot&apos;s Credentials tab.
      </InlineAlert>

      {revealed && <RevealPanel title={`${KIND_LABELS[revealed.kind]} · ${revealed.label}`} username={revealed.username} secret={revealed.secret} onHide={() => setRevealed(null)} />}

      <Card
        title="Client credentials"
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
      >
        <QueryView query={q}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState title="No credentials stored" description={`GCS logins, API tokens, Wi-Fi or VPN access Arnobot keeps for ${org.name}.`} icon={<Lock className="size-8" />} />
            ) : (
              <DataTable
                caption={`Credentials for ${org.name} (metadata only)`}
                rows={list}
                rowKey={(c) => c.id}
                rowClassName={(c) => (c.revoked_at ? 'opacity-60' : undefined)}
                columns={[
                  {
                    key: 'l',
                    header: 'Credential',
                    rowHeader: true,
                    cell: (c) => (
                      <span>
                        {c.label}
                        <span className="block text-xs text-muted">
                          {KIND_LABELS[c.kind]}
                          {c.robot_id && ` · ${c.robot_id}`}
                        </span>
                      </span>
                    ),
                  },
                  { key: 'u', header: 'Username', cell: (c) => (c.username ? <Mono>{c.username}</Mono> : '—') },
                  {
                    key: 'url',
                    header: 'URL',
                    className: 'max-w-xs',
                    cell: (c) => (c.url ? <span className="block truncate font-mono text-xs" title={c.url}>{c.url}</span> : <span className="text-muted">—</span>),
                  },
                  { key: 's', header: 'Secret', cell: () => <span aria-label="hidden secret">••••••••</span> },
                  {
                    key: 'c',
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
                    key: 'st',
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
                    key: 'a',
                    header: <span className="sr-only">Actions</span>,
                    align: 'right',
                    cell: (c) =>
                      c.revoked_at ? null : (
                        <span className="flex justify-end gap-1">
                          {canReveal && (
                            <Button size="sm" icon={<Eye className="size-3.5" aria-hidden />} onClick={() => setConfirmReveal(c)} aria-label={`Reveal ${c.label}`}>
                              Reveal
                            </Button>
                          )}
                          {canWrite && (
                            <>
                              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => setRotating(c)} aria-label={`Rotate ${c.label}`}>
                                Rotate
                              </Button>
                              <Button size="sm" variant="ghost" icon={<ShieldX className="size-3.5" aria-hidden />} onClick={() => setRevoking(c)} aria-label={`Revoke ${c.label}`}>
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
      </Card>

      <ConfirmDialog
        open={!!confirmReveal}
        onClose={() => setConfirmReveal(null)}
        onConfirm={() => confirmReveal && void doReveal(confirmReveal)}
        loading={revealing}
        title="Reveal secret?"
        description={`The decrypted value of "${confirmReveal?.label ?? ''}" will be shown on screen and the reveal is audited. It hides again after ${REVEAL_SECONDS} seconds.`}
        confirmLabel="Reveal"
      />
      <AddDialog org={org} open={adding} onClose={() => setAdding(false)} />
      <RotateDialog org={org} cred={rotating} onClose={() => setRotating(null)} />
      <RevokeDialog org={org} cred={revoking} onClose={() => setRevoking(null)} />
    </div>
  );
}

function AddDialog({ org, open, onClose }: { org: OrganizationDetailDto; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const blank = { kind: '' as ClientCredentialKind | '', label: '', username: '', url: '', robot_id: '', notes: '', secret: '' };
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const close = () => {
    setF(blank);
    setError(null);
    onClose();
  };
  // Direct call so the secret in the request is not retained by the mutation cache.
  const submit = async () => {
    if (!f.kind || !f.label.trim() || !f.secret) return setError('Kind, label and secret are required');
    setBusy(true);
    try {
      await api.post<ClientCredentialDto>(`/organizations/${org.id}/credentials`, {
        kind: f.kind,
        label: f.label.trim(),
        username: f.username.trim() || null,
        url: f.url.trim() || null,
        robot_id: f.robot_id || null,
        notes: f.notes.trim() || null,
        secret: f.secret,
      });
      toast.success('Credential stored (encrypted)');
      void qc.invalidateQueries({ queryKey: ['organizations', org.id, 'credentials'] });
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Add a credential for ${org.name}`}
      description="Encrypted before it is stored. The secret is typed once; use Rotate to replace it later."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Store encrypted
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Kind" required>
          <Select value={f.kind} onChange={(e) => set({ kind: e.target.value as ClientCredentialKind })} data-autofocus>
            <option value="">Choose…</option>
            {CLIENT_CREDENTIAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Label" required hint="e.g. Control room Wi-Fi">
          <Input value={f.label} onChange={(e) => set({ label: e.target.value })} />
        </Field>
        <Field label="Username" hint="Not secret; shown in the list.">
          <Input value={f.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="URL" hint="Never put a user name or password inside the URL.">
          <Input type="url" value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://" />
        </Field>
        <Field label="Robot">
          <Select value={f.robot_id} onChange={(e) => set({ robot_id: e.target.value })}>
            <option value="">Not bound to a robot</option>
            {org.robots.map((r) => (
              <option key={r.robot_id} value={r.robot_id}>
                {r.robot_id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Secret / password" required>
          <SecretInput value={f.secret} onChange={(v) => set({ secret: v })} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
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

function RotateDialog({ org, cred, onClose }: { org: OrganizationDetailDto; cred: ClientCredentialDto | null; onClose: () => void }) {
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
      await api.post<ClientCredentialDto>(`/client-credentials/${cred!.id}/rotate`, { secret, username: username.trim() || null });
      toast.success('Credential rotated: old value revoked, new value stored');
      void qc.invalidateQueries({ queryKey: ['organizations', org.id, 'credentials'] });
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
      title={`Rotate ${cred?.label ?? ''}`}
      description="The old value is revoked and kept for the record."
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
          <SecretInput value={secret} onChange={setSecret} />
        </Field>
      </form>
    </Dialog>
  );
}

function RevokeDialog({ org, cred, onClose }: { org: OrganizationDetailDto; cred: ClientCredentialDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<ClientCredentialDto>(`/client-credentials/${cred!.id}/revoke`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success('Credential revoked');
      void qc.invalidateQueries({ queryKey: ['organizations', org.id, 'credentials'] });
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
      title={`Revoke ${cred?.label ?? ''}?`}
      description="Use this when a credential is lost, stolen or no longer used. The record is kept but marked revoked."
      confirmLabel="Revoke"
    >
      <Field label="Reason" required>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}
