'use client';

import { RobotRef } from '@/components/domain/robot-ref';

import type { IngestClientDto, IngestKeyIssuedDto, Paginated, RobotListItemDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, ShieldX } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { OneTimeKey } from '@/components/domain/one-time-secret';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { Badge, EmptyState, InlineAlert, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

function useRobotOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['robots', 'options'],
    queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { limit: 200 }),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Robot and GCS ingest clients with their keys: issue, revoke, edit a GCS client's robots.
 * With robotIds (a robot page), only the clients that send for one of those robots are listed and a new GCS
 * client starts with them ticked; without, every client (the Ingest page).
 */
export function IngestClientsPanel({ robotIds, scopeLabel }: { robotIds?: string[]; scopeLabel?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IngestKeyIssuedDto | null>(null);
  const [editing, setEditing] = useState<IngestClientDto | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'key' | 'client'; id: string; label: string } | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const q = useQuery({ queryKey: ['ingest-clients', 'all'], queryFn: () => api.get<IngestClientDto[]>('/ingest-clients') });

  const newKey = useMutation({
    mutationFn: (id: string) => api.post<IngestKeyIssuedDto>(`/ingest-clients/${id}/keys`),
    onSuccess: (r) => {
      setIssued(r);
      void qc.invalidateQueries({ queryKey: ['ingest-clients'] });
    },
    onError: toast.error,
    gcTime: 0,
  });
  const revoke = useMutation({
    mutationFn: (c: { kind: 'key' | 'client'; id: string }) => api.post<IngestClientDto>(c.kind === 'key' ? `/ingest-keys/${c.id}/revoke` : `/ingest-clients/${c.id}/revoke`),
    onSuccess: () => {
      toast.success('Revoked: refused within about 10 seconds');
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['ingest-clients'] });
    },
    onError: toast.error,
  });

  return (
    <div className="flex flex-col gap-4">
      <InlineAlert tone="accent" title="How robots and the GCS authenticate">
        Each client sends <Mono>Authorization: Bearer &lt;key&gt;</Mono>. A <strong>robot</strong> key may only send data for its own robot; a <strong>GCS</strong> key may send data and
        mission reports for the robots assigned to it. Keys are shown once and stored only as a hash. Keep them in server-side environment variables, never in <Mono>NEXT_PUBLIC_*</Mono>.
      </InlineAlert>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Checkbox label="Show revoked clients" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
        <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)} disabled={robotIds?.length === 0}>
          New GCS client
        </Button>
      </div>
      <QueryView query={q}>
        {(clients) => {
          const list = clients.filter((c) => (showRevoked || !c.revoked_at) && (!robotIds || c.robot_ids.some((r) => robotIds.includes(r))));
          return list.length === 0 ? (
            <EmptyState
              title="No ingest clients"
              description={
                robotIds
                  ? `No client sends data for ${scopeLabel ?? 'this robot'} yet. Registering a robot creates its robot client automatically.`
                  : 'Registering a robot creates its robot client automatically. Create a GCS client for each ground station that relays data.'
              }
            />
          ) : (
            <DataTable
              caption={scopeLabel ? `Ingest clients of ${scopeLabel}` : 'Ingest clients'}
              rows={list}
              rowKey={(c) => c.id}
              rowClassName={(c) => (c.revoked_at ? 'opacity-60' : undefined)}
              columns={[
                {
                  key: 'n',
                  header: 'Client',
                  rowHeader: true,
                  cell: (c) => (
                    <span>
                      {c.name}
                      {c.notes && <span className="block text-xs text-muted">{c.notes}</span>}
                    </span>
                  ),
                },
                { key: 'k', header: 'Kind', cell: (c) => <Badge tone={c.kind === 'gcs' ? 'accent' : 'neutral'}>{c.kind === 'gcs' ? 'GCS' : 'Robot'}</Badge> },
                {
                  key: 'r',
                  header: 'Robots',
                  cell: (c) => (
                    <span className="flex flex-wrap gap-1">
                      {c.robot_ids.map((r) => (
                        <Link key={r} href={`/robots/${r}`} className="font-mono text-xs text-accent-text hover:underline">
                          {r}
                        </Link>
                      ))}
                    </span>
                  ),
                },
                {
                  key: 'keys',
                  header: 'Keys',
                  cell: (c) => (
                    <ul className="flex flex-col gap-1 text-xs">
                      {c.keys.map((k) => (
                        <li key={k.id} className="flex flex-wrap items-center gap-2">
                          <Mono>{k.key_prefix}…</Mono>
                          {k.revoked_at ? <Badge tone="fault">Revoked</Badge> : <span className="text-muted">last used <Time iso={k.last_used_at} relative /></span>}
                          {!k.revoked_at && !c.revoked_at && (
                            <button type="button" className="text-fault hover:underline" onClick={() => setConfirm({ kind: 'key', id: k.id, label: `${k.key_prefix}…` })}>
                              Revoke<span className="sr-only"> key {k.key_prefix}</span>
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  ),
                },
                { key: 'c', header: 'Created', cell: (c) => <Time iso={c.created_at} /> },
                {
                  key: 'a',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  cell: (c) =>
                    c.revoked_at ? (
                      <Badge tone="fault">Revoked</Badge>
                    ) : (
                      <span className="flex justify-end gap-1">
                        <Button size="sm" icon={<KeyRound className="size-3.5" aria-hidden />} onClick={() => newKey.mutate(c.id)} loading={newKey.isPending && newKey.variables === c.id} aria-label={`Issue new key for ${c.name}`}>
                          New key
                        </Button>
                        {c.kind === 'gcs' && (
                          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(c)} aria-label={`Edit robots of ${c.name}`}>
                            Robots
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" icon={<ShieldX className="size-3.5" aria-hidden />} onClick={() => setConfirm({ kind: 'client', id: c.id, label: c.name })} aria-label={`Revoke ${c.name}`}>
                          Revoke
                        </Button>
                      </span>
                    ),
                },
              ]}
            />
          );
        }}
      </QueryView>
      <CreateGcsDialog open={creating} onClose={() => setCreating(false)} onIssued={setIssued} initialRobotIds={robotIds} />
      <EditRobotsDialog client={editing} onClose={() => setEditing(null)} />
      <Dialog open={!!issued} onClose={() => setIssued(null)} title={`Key for ${issued?.client.name ?? ''}`} footer={<Button variant="primary" onClick={() => setIssued(null)}>I have stored the key</Button>}>
        {issued && (
          <OneTimeKey value={issued.key}>
            {issued.client.kind === 'gcs' && (
              <p className="text-sm text-muted">
                On the GCS server set it as <Mono>PMS_INGEST_KEY</Mono> (server-side only). See docs/gcs/gcs-integration-checklist.md.
              </p>
            )}
          </OneTimeKey>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && revoke.mutate(confirm)}
        loading={revoke.isPending}
        danger
        title={confirm?.kind === 'client' ? `Revoke client ${confirm.label}?` : `Revoke key ${confirm?.label ?? ''}?`}
        description={confirm?.kind === 'client' ? 'All keys of this client stop working. This cannot be undone; create a new client instead.' : 'Anything still using this key will be refused.'}
        confirmLabel="Revoke"
      />
    </div>
  );
}

function RobotPicker({ value, onChange, robots }: { value: string[]; onChange: (v: string[]) => void; robots: RobotListItemDto[] }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Robots this GCS may send data for</legend>
      {robots.length === 0 ? (
        <p className="text-sm text-muted">No robots registered.</p>
      ) : (
        <div className="grid max-h-60 gap-1 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2">
          {robots.map((r) => (
            <Checkbox
              key={r.robot_id}
              label={
                <span>
                  <RobotRef id={r.robot_id} link={false} />
                </span>
              }
              checked={value.includes(r.robot_id)}
              onChange={(e) => onChange(e.target.checked ? [...value, r.robot_id] : value.filter((x) => x !== r.robot_id))}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

function CreateGcsDialog({ open, onClose, onIssued, initialRobotIds }: { open: boolean; onClose: () => void; onIssued: (r: IngestKeyIssuedDto) => void; initialRobotIds?: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const robots = useRobotOptions(open);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [robotIds, setRobotIds] = useState<string[]>([]);
  useEffect(() => {
    if (open) setRobotIds(initialRobotIds ?? []);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({
    mutationFn: () => api.post<IngestKeyIssuedDto>('/ingest-clients', { name: name.trim(), kind: 'gcs', robot_ids: robotIds, notes: notes.trim() || undefined }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['ingest-clients'] });
      setName('');
      setNotes('');
      setRobotIds([]);
      onClose();
      onIssued(r);
    },
    onError: toast.error,
    gcTime: 0,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="New GCS ingest client"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim() || robotIds.length === 0}>
            Create and issue key
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name" required hint="e.g. GCS saibya02 (Jetson Orin, site X)">
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <RobotPicker value={robotIds} onChange={setRobotIds} robots={robots.data?.items ?? []} />
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function EditRobotsDialog({ client, onClose }: { client: IngestClientDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const robots = useRobotOptions(!!client);
  const [robotIds, setRobotIds] = useState<string[]>([]);
  useEffect(() => setRobotIds(client?.robot_ids ?? []), [client]);
  const m = useMutation({
    mutationFn: () => api.put<IngestClientDto>(`/ingest-clients/${client!.id}/robots`, { robot_ids: robotIds }),
    onSuccess: () => {
      toast.success('Robots updated');
      void qc.invalidateQueries({ queryKey: ['ingest-clients'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!client}
      onClose={onClose}
      size="lg"
      title={`Robots for ${client?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={robotIds.length === 0}>
            Save
          </Button>
        </>
      }
    >
      <RobotPicker value={robotIds} onChange={setRobotIds} robots={robots.data?.items ?? []} />
    </Dialog>
  );
}
