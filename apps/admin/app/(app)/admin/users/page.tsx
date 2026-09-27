'use client';

import type { GrantDto, Paginated, RobotListItemDto, RoleDto, ScopeType, UserDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RotateCcw, ShieldPlus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Badge, EmptyState, InlineAlert, PageHeader, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';
import { useCompanies } from '@/lib/queries';

const MIN_PASSWORD = 10;

function scopeLabel(g: Pick<GrantDto, 'scope_type' | 'scope_id'>, companies?: { id: string; name: string }[]) {
  if (g.scope_type === 'platform') return 'Platform';
  if (g.scope_type === 'company') return `Company: ${companies?.find((c) => c.id === g.scope_id)?.name ?? g.scope_id}`;
  if (g.scope_type === 'robot') return `Robot: ${g.scope_id}`;
  return `Site: ${g.scope_id}`;
}

/** Spec §12: User → Role → Permission → Scope (Platform, Company, Site or Robot). */
export default function UsersPage() {
  useDocumentTitle('Users & roles');
  const can = useCan();
  const me = useMe();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [granting, setGranting] = useState<UserDto | null>(null);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const [revoking, setRevoking] = useState<GrantDto | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const companies = useCompanies();
  const users = useQuery({ queryKey: ['users', includeDeleted], queryFn: () => api.get<UserDto[]>('/users', { include_deleted: includeDeleted }), enabled: can('user.manage') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleDto[]>('/roles'), enabled: can('user.manage'), staleTime: 300_000 });

  const del = useMutation({
    mutationFn: (u: UserDto) => (u.deleted_at ? api.post(`/users/${u.id}/restore`) : api.del(`/users/${u.id}`)),
    onSuccess: (_x, u) => {
      toast.success(u.deleted_at ? 'User restored' : 'User deleted and signed out');
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: toast.error,
  });
  const revokeGrant = useMutation({
    mutationFn: (g: GrantDto) => api.post<UserDto>(`/grants/${g.id}/revoke`),
    onSuccess: () => {
      toast.success('Role grant revoked');
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: toast.error,
  });

  if (!can('user.manage')) {
    return (
      <>
        <PageHeader title="Users & roles" />
        <InlineAlert tone="fault">You don&apos;t have permission to manage users.</InlineAlert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Users & roles"
        description="Arnobot team logins. Each user gets one or more roles, each applying at a scope: the whole platform, a company, a site (future) or a single robot."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
            Add user
          </Button>
        }
      />
      <div className="mb-3">
        <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
      </div>
      <QueryView query={users}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No users" />
          ) : (
            <DataTable
              caption="Users"
              rows={list}
              rowKey={(u) => u.id}
              rowClassName={(u) => (u.deleted_at || !u.is_active ? 'opacity-60' : undefined)}
              columns={[
                {
                  key: 'n',
                  header: 'User',
                  rowHeader: true,
                  cell: (u) => (
                    <span>
                      <span className="font-semibold">{u.name}</span>
                      {u.id === me.id && <Badge tone="accent" className="ml-2">You</Badge>}
                      <span className="block text-xs text-muted">{u.email}</span>
                    </span>
                  ),
                },
                {
                  key: 's',
                  header: 'State',
                  cell: (u) => (u.deleted_at ? <Badge tone="fault">Deleted</Badge> : u.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="offline">Disabled</Badge>),
                },
                {
                  key: 'g',
                  header: 'Roles',
                  className: 'min-w-72',
                  cell: (u) => {
                    const active = u.grants.filter((g) => !g.revoked_at);
                    return active.length === 0 ? (
                      <span className="text-xs text-muted">No roles: cannot see anything</span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {active.map((g) => (
                          <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs">
                            <Badge tone="accent">{g.role_name}</Badge>
                            <span>{scopeLabel(g, companies.data)}</span>
                            {!u.deleted_at && (
                              <button type="button" onClick={() => setRevoking(g)} className="rounded p-0.5 text-muted hover:text-fault" aria-label={`Revoke ${g.role_name} (${scopeLabel(g, companies.data)}) from ${u.name}`}>
                                <X className="size-3.5" aria-hidden />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    );
                  },
                },
                { key: 'l', header: 'Last sign-in', cell: (u) => <Time iso={u.last_login_at} relative /> },
                {
                  key: 'a',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  cell: (u) => (
                    <span className="flex justify-end gap-1">
                      {!u.deleted_at && (
                        <>
                          <Button size="sm" variant="ghost" icon={<ShieldPlus className="size-3.5" aria-hidden />} onClick={() => setGranting(u)} aria-label={`Add role to ${u.name}`}>
                            Role
                          </Button>
                          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`}>
                            Edit
                          </Button>
                        </>
                      )}
                      {u.id !== me.id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={u.deleted_at ? <RotateCcw className="size-3.5" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                          onClick={() => (u.deleted_at ? del.mutate(u) : setDeleting(u))}
                          aria-label={`${u.deleted_at ? 'Restore' : 'Delete'} ${u.name}`}
                        >
                          {u.deleted_at ? 'Restore' : 'Delete'}
                        </Button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          )
        }
      </QueryView>

      {roles.data && (
        <section aria-labelledby="roles-heading" className="mt-8">
          <h2 id="roles-heading" className="mb-3 text-lg font-semibold">
            Roles
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {roles.data.map((r) => (
              <article key={r.id} className="rounded-lg border border-border bg-surface p-4">
                <h3 className="font-semibold">{r.name}</h3>
                {r.description && <p className="mb-2 text-sm text-muted">{r.description}</p>}
                <ul className="flex flex-wrap gap-1" aria-label={`Permissions of ${r.name}`}>
                  {r.permissions.map((p) => (
                    <li key={p}>
                      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{p}</code>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
      )}

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} roles={roles.data ?? []} />
      <EditUserDialog user={editing} onClose={() => setEditing(null)} isSelf={editing?.id === me.id} />
      <GrantDialog user={granting} onClose={() => setGranting(null)} roles={roles.data ?? []} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        loading={del.isPending}
        danger
        title={`Delete ${deleting?.name ?? ''}?`}
        description="The user is signed out everywhere and can no longer sign in. Soft delete: restorable. Remember to rotate any robot credentials they had access to."
        confirmLabel="Delete user"
      />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revokeGrant.mutate(revoking)}
        loading={revokeGrant.isPending}
        danger
        title="Revoke role?"
        description={revoking ? `${revoking.role_name} · ${scopeLabel(revoking, companies.data)}` : undefined}
        confirmLabel="Revoke"
      />
    </>
  );
}

function ScopeFields({ scopeType, scopeId, onType, onId }: { scopeType: ScopeType; scopeId: string; onType: (v: ScopeType) => void; onId: (v: string) => void }) {
  const companies = useCompanies();
  const robots = useQuery({ queryKey: ['robots', 'options'], queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { limit: 200 }), enabled: scopeType === 'robot', staleTime: 60_000 });
  return (
    <>
      <Field label="Scope" required hint="Where the role applies">
        <Select
          value={scopeType}
          onChange={(e) => {
            onType(e.target.value as ScopeType);
            onId('');
          }}
        >
          <option value="platform">Platform (everything)</option>
          <option value="company">Company</option>
          <option value="robot">Single robot</option>
          <option value="site">Site (future)</option>
        </Select>
      </Field>
      {scopeType === 'company' && (
        <Field label="Company" required>
          <Select value={scopeId} onChange={(e) => onId(e.target.value)}>
            <option value="">Choose…</option>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {scopeType === 'robot' && (
        <Field label="Robot" required>
          <Select value={scopeId} onChange={(e) => onId(e.target.value)}>
            <option value="">Choose…</option>
            {robots.data?.items.map((r) => (
              <option key={r.robot_id} value={r.robot_id}>
                {r.robot_id}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {scopeType === 'site' && (
        <Field label="Site ID" required hint="Sites are not used in v1.">
          <Input value={scopeId} onChange={(e) => onId(e.target.value)} />
        </Field>
      )}
    </>
  );
}

function CreateUserDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: RoleDto[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ email: '', name: '', password: '', role_key: 'viewer' });
  const [scopeType, setScopeType] = useState<ScopeType>('platform');
  const [scopeId, setScopeId] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<UserDto>('/users', { ...f, email: f.email.trim(), name: f.name.trim(), scope_type: scopeType, scope_id: scopeType === 'platform' ? undefined : scopeId }),
    onSuccess: () => {
      toast.success('User created');
      void qc.invalidateQueries({ queryKey: ['users'] });
      setF({ email: '', name: '', password: '', role_key: 'viewer' });
      onClose();
    },
    onError: toast.error,
  });
  const pwShort = f.password.length > 0 && f.password.length < MIN_PASSWORD;
  const valid = /\S+@\S+\.\S+/.test(f.email) && f.name.trim() && f.password.length >= MIN_PASSWORD && f.role_key && (scopeType === 'platform' || scopeId);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add user"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>
            Create user
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Name" required>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus />
        </Field>
        <Field label="Email" required>
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" />
        </Field>
        <Field label="Initial password" required hint={`At least ${MIN_PASSWORD} characters. Share it securely; the user can change it under My account.`} error={pwShort ? `At least ${MIN_PASSWORD} characters` : null} className="sm:col-span-2">
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Role" required>
          <Select value={f.role_key} onChange={(e) => setF({ ...f, role_key: e.target.value })}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <ScopeFields scopeType={scopeType} scopeId={scopeId} onType={setScopeType} onId={setScopeId} />
      </form>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose, isSelf }: { user: UserDto | null; onClose: () => void; isSelf: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [password, setPassword] = useState('');
  useEffect(() => {
    setName(user?.name ?? '');
    setActive(user?.is_active ?? true);
    setPassword('');
  }, [user]);
  const m = useMutation({
    mutationFn: () => api.patch<UserDto>(`/users/${user!.id}`, { name: name.trim(), is_active: active, password: password || undefined }),
    onSuccess: () => {
      toast.success('User updated');
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: toast.error,
  });
  const pwShort = password.length > 0 && password.length < MIN_PASSWORD;
  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      title={`Edit ${user?.name ?? ''}`}
      description={user?.email}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim() || pwShort}>
            Save
          </Button>
        </>
      }
    >
      <form className="grid gap-4" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Checkbox label="Active (can sign in)" checked={active} disabled={isSelf} onChange={(e) => setActive(e.target.checked)} />
        <Field label="Reset password" hint="Leave empty to keep the current password. Resetting signs the user out." error={pwShort ? `At least ${MIN_PASSWORD} characters` : null}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </form>
    </Dialog>
  );
}

function GrantDialog({ user, onClose, roles }: { user: UserDto | null; onClose: () => void; roles: RoleDto[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [roleKey, setRoleKey] = useState('viewer');
  const [scopeType, setScopeType] = useState<ScopeType>('platform');
  const [scopeId, setScopeId] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<UserDto>(`/users/${user!.id}/grants`, { role_key: roleKey, scope_type: scopeType, scope_id: scopeType === 'platform' ? undefined : scopeId }),
    onSuccess: () => {
      toast.success('Role granted');
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      title={`Add role to ${user?.name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={scopeType !== 'platform' && !scopeId}>
            Grant
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role" required>
          <Select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} data-autofocus>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <ScopeFields scopeType={scopeType} scopeId={scopeId} onType={setScopeType} onId={setScopeId} />
      </div>
    </Dialog>
  );
}
