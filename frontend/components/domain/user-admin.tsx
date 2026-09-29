'use client';

import type { CompanyDto, GrantDto, OrganizationDetailDto, Paginated, RobotListItemDto, RoleDto, ScopeType, UserCredentialsDto, UserDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2, Mail, Pencil, RotateCcw, ShieldPlus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Badge, CopyButton, EmptyState, InlineAlert, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useCompanies } from '@/lib/queries';

export const MIN_PASSWORD = 10;

export function scopeLabel(g: Pick<GrantDto, 'scope_type' | 'scope_id'>, companies?: { id: string; name: string }[]) {
  if (g.scope_type === 'platform') return 'All of Arnobot (platform)';
  if (g.scope_type === 'company') return `Organization: ${companies?.find((c) => c.id === g.scope_id)?.name ?? g.scope_id}`;
  if (g.scope_type === 'robot') return `Robot: ${g.scope_id}`;
  return `Site: ${g.scope_id}`;
}

export function useRoles(enabled = true) {
  return useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleDto[]>('/roles'), staleTime: 300_000, enabled });
}

const isSuperAdmin = (grants: GrantDto[]) => grants.some((g) => g.role_key === 'super_admin' && g.scope_type === 'platform' && !g.revoked_at);

/** Invitation link or temporary password, shown exactly once. */
export function CredentialsResultDialog({ result, onClose }: { result: UserCredentialsDto | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!result}
      onClose={onClose}
      title={result?.invite_url ? 'Invitation link ready' : 'Temporary password ready'}
      description={result ? `${result.user.name} · ${result.user.email} · ${result.user.company_name}` : undefined}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {result && (
        <div className="flex flex-col gap-3">
          <InlineAlert tone="warn" title="Copy it now: it will not be shown again">
            The PMS stores only a hash. Send it to {result.user.name} over a trusted channel (e.g. your company email), never in a public chat.
            {result.invite_url
              ? ` The link works once and expires ${fmtDateTime(result.invite_expires_at)}. They choose their own password.`
              : ' They must choose a new password when they first sign in.'}
          </InlineAlert>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-3">
            {result.invite_url ? <Link2 className="size-4 text-muted" aria-hidden /> : <KeyRound className="size-4 text-muted" aria-hidden />}
            <code className="min-w-0 flex-1 font-mono text-sm break-all select-all" data-testid="one-time-credential">
              {result.invite_url ?? result.temporary_password}
            </code>
            <CopyButton value={(result.invite_url ?? result.temporary_password)!} label={result.invite_url ? 'Copy link' : 'Copy password'} />
          </div>
          {result.invite_url && (
            <a
              className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
              href={`mailto:${encodeURIComponent(result.user.email)}?subject=${encodeURIComponent('Your Arnobot PMS account')}&body=${encodeURIComponent(
                `Hello ${result.user.name},\n\nYou have been invited to the Arnobot Product Management System (${result.user.company_name}).\nSet your password here (the link works once and expires ${fmtDateTime(result.invite_expires_at)}):\n\n${result.invite_url}\n`,
              )}`}
            >
              <Mail className="size-4" aria-hidden /> Open an email to {result.user.email}
            </a>
          )}
        </div>
      )}
    </Dialog>
  );
}

function RoleSelect({ roles, audience, value, onChange }: { roles: RoleDto[]; audience: 'staff' | 'customer'; value: string; onChange: (v: string) => void }) {
  // Admin is Arnobot-only; Manager and Viewer fit Arnobot staff and customer organizations alike.
  const list = roles.filter((r) => r.audience === audience || r.audience === 'any');
  const current = list.find((r) => r.key === value);
  return (
    <Field label="Role" required hint={current?.description ?? undefined}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {list.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * Where a grant applies. Arnobot staff: platform (super-admin only), an organization or one robot.
 * Customer users: their own organization, or one robot it owns (the API enforces the same rules).
 */
function ScopeFields({
  customerOrgId,
  scopeType,
  scopeId,
  onType,
  onId,
}: {
  customerOrgId: string | null;
  scopeType: ScopeType;
  scopeId: string;
  onType: (v: ScopeType) => void;
  onId: (v: string) => void;
}) {
  const me = useMe();
  const companies = useCompanies();
  const superAdmin = isSuperAdmin(me.grants);
  const orgRobots = useQuery({
    queryKey: ['organizations', customerOrgId],
    queryFn: () => api.get<OrganizationDetailDto>(`/organizations/${customerOrgId}`),
    enabled: !!customerOrgId && scopeType === 'robot',
  });
  const allRobots = useQuery({
    queryKey: ['robots', 'options'],
    queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { limit: 200 }),
    enabled: !customerOrgId && scopeType === 'robot',
    staleTime: 60_000,
  });
  const robots = customerOrgId ? (orgRobots.data?.robots.map((r) => r.robot_id) ?? []) : (allRobots.data?.items.map((r) => r.robot_id) ?? []);
  return (
    <>
      <Field label="Applies to" required hint={customerOrgId ? 'Customer users only ever see their own organization.' : undefined}>
        <Select
          value={scopeType}
          onChange={(e) => {
            onType(e.target.value as ScopeType);
            onId(e.target.value === 'company' && customerOrgId ? customerOrgId : '');
          }}
        >
          {customerOrgId ? (
            <>
              <option value="company">All its robots</option>
              <option value="robot">One of its robots</option>
            </>
          ) : (
            <>
              {superAdmin && <option value="platform">All of Arnobot (platform)</option>}
              <option value="company">One organization</option>
              <option value="robot">One robot</option>
            </>
          )}
        </Select>
      </Field>
      {scopeType === 'company' && !customerOrgId && (
        <Field label="Organization" required>
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
        <Field label="Robot" required hint={customerOrgId && !robots.length ? 'This organization has no robots yet. Assign one first.' : undefined}>
          <Select value={scopeId} onChange={(e) => onId(e.target.value)}>
            <option value="">Choose…</option>
            {robots.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );
}

export function CreateUserDialog({
  open,
  onClose,
  roles,
  organization,
}: {
  open: boolean;
  onClose: () => void;
  roles: RoleDto[];
  /** Fixed organization (organization page); otherwise the admin picks one. */
  organization?: Pick<CompanyDto, 'id' | 'name' | 'kind'>;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const companies = useCompanies(!organization);
  const orgs = organization ? [organization] : (companies.data ?? []);
  const blank = { email: '', name: '', company_id: organization?.id ?? '', credentials: 'invite' as 'invite' | 'temporary_password', role_key: '' };
  const [f, setF] = useState(blank);
  const [scopeType, setScopeType] = useState<ScopeType>('company');
  const [scopeId, setScopeId] = useState('');
  const [result, setResult] = useState<UserCredentialsDto | null>(null);
  const org = orgs.find((o) => o.id === f.company_id);
  const audience = org?.kind === 'customer' ? 'customer' : 'staff';
  const superAdmin = isSuperAdmin(me.grants);

  // Sensible defaults whenever the organization changes.
  useEffect(() => {
    if (!open) return;
    if (!f.company_id && orgs.length) setF((x) => ({ ...x, company_id: organization?.id ?? orgs.find((o) => o.kind === 'internal')?.id ?? orgs[0].id }));
  }, [open, orgs, f.company_id, organization]);
  useEffect(() => {
    const first = roles.find((r) => r.key === 'viewer') ?? roles.find((r) => r.audience === audience || r.audience === 'any');
    setF((x) => ({ ...x, role_key: first?.key ?? '' }));
    if (audience === 'customer') {
      setScopeType('company');
      setScopeId(f.company_id);
    } else {
      setScopeType(superAdmin ? 'platform' : 'company');
      setScopeId('');
    }
  }, [audience, f.company_id, roles, superAdmin]);

  const m = useMutation({
    mutationFn: () =>
      api.post<UserCredentialsDto>('/users', {
        email: f.email.trim(),
        name: f.name.trim(),
        company_id: f.company_id,
        credentials: f.credentials,
        role_key: f.role_key,
        scope_type: scopeType,
        scope_id: scopeType === 'platform' ? undefined : scopeId,
      }),
    onSuccess: (r) => {
      toast.success(f.credentials === 'invite' ? 'User invited' : 'User created');
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      setF(blank);
      onClose();
      setResult(r);
    },
    onError: toast.error,
  });
  const valid = /\S+@\S+\.\S+/.test(f.email) && f.name.trim() && f.company_id && f.role_key && (scopeType === 'platform' || scopeId);
  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={organization ? `Invite a ${organization.name} user` : 'Add user'}
        description="Pick how they get their login. Both are one-time: the PMS never shows a password twice."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>
              {f.credentials === 'invite' ? 'Create invitation' : 'Create user'}
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
          {!organization && (
            <Field label="Organization" required hint={audience === 'customer' ? 'A customer user sees only this organization’s robots.' : 'Arnobot staff.'} className="sm:col-span-2">
              <Select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.kind === 'internal' ? ' (Arnobot staff)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <fieldset className="flex flex-col gap-2 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">Sign-in credentials</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="cred" className="mt-1" checked={f.credentials === 'invite'} onChange={() => setF({ ...f, credentials: 'invite' })} />
              <span>
                <span className="font-medium">Invitation link</span> <span className="text-muted">(recommended): they set their own password; the link works once and expires in 72 hours.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="cred" className="mt-1" checked={f.credentials === 'temporary_password'} onChange={() => setF({ ...f, credentials: 'temporary_password' })} />
              <span>
                <span className="font-medium">Temporary password</span> <span className="text-muted">generated by the PMS; they must change it at first sign-in.</span>
              </span>
            </label>
          </fieldset>
          <RoleSelect roles={roles} audience={audience} value={f.role_key} onChange={(v) => setF({ ...f, role_key: v })} />
          <ScopeFields customerOrgId={audience === 'customer' ? f.company_id : null} scopeType={scopeType} scopeId={scopeId} onType={setScopeType} onId={setScopeId} />
        </form>
      </Dialog>
      <CredentialsResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}

function EditUserDialog({ user, onClose, isSelf }: { user: UserDto | null; onClose: () => void; isSelf: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  useEffect(() => {
    setName(user?.name ?? '');
    setActive(user?.is_active ?? true);
  }, [user]);
  const m = useMutation({
    mutationFn: () => api.patch<UserDto>(`/users/${user!.id}`, { name: name.trim(), is_active: active }),
    onSuccess: () => {
      toast.success('User updated');
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      title={`Edit ${user?.name ?? ''}`}
      description={user ? `${user.email} · ${user.company_name}` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form className="grid gap-4" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Checkbox label="Active (can sign in). Disabling signs them out everywhere." checked={active} disabled={isSelf} onChange={(e) => setActive(e.target.checked)} />
      </form>
    </Dialog>
  );
}

function ReissueDialog({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [method, setMethod] = useState<'invite' | 'temporary_password'>('invite');
  const [result, setResult] = useState<UserCredentialsDto | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<UserCredentialsDto>(`/users/${user!.id}/credentials`, { method }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      onClose();
      setResult(r);
    },
    onError: toast.error,
  });
  return (
    <>
      <Dialog
        open={!!user}
        onClose={onClose}
        title={`New sign-in credentials for ${user?.name ?? ''}`}
        description="Their current password and every session stop working immediately."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" onClick={() => m.mutate()} loading={m.isPending}>
              Issue new credentials
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" name="reissue" className="mt-1" checked={method === 'invite'} onChange={() => setMethod('invite')} data-autofocus />
            <span>
              <span className="font-medium">New invitation link</span> <span className="text-muted">(they set a new password)</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="reissue" className="mt-1" checked={method === 'temporary_password'} onChange={() => setMethod('temporary_password')} />
            <span>
              <span className="font-medium">Temporary password</span> <span className="text-muted">(changed at next sign-in)</span>
            </span>
          </label>
        </div>
      </Dialog>
      <CredentialsResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}

function GrantDialog({ user, onClose, roles }: { user: UserDto | null; onClose: () => void; roles: RoleDto[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const customer = user?.company_kind === 'customer';
  const audience = customer ? 'customer' : 'staff';
  const [roleKey, setRoleKey] = useState('');
  const [scopeType, setScopeType] = useState<ScopeType>('company');
  const [scopeId, setScopeId] = useState('');
  useEffect(() => {
    if (!user) return;
    setRoleKey(roles.find((r) => r.key === 'viewer')?.key ?? roles.find((r) => r.audience === audience || r.audience === 'any')?.key ?? '');
    setScopeType(customer ? 'company' : isSuperAdmin(me.grants) ? 'platform' : 'company');
    setScopeId(customer ? user.company_id : '');
  }, [user, roles, audience, customer, me.grants]);
  const m = useMutation({
    mutationFn: () => api.post<UserDto>(`/users/${user!.id}/grants`, { role_key: roleKey, scope_type: scopeType, scope_id: scopeType === 'platform' ? undefined : scopeId }),
    onSuccess: () => {
      toast.success('Role granted');
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      title={`Add role to ${user?.name ?? ''}`}
      description={user?.company_name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!roleKey || (scopeType !== 'platform' && !scopeId)}>
            Grant
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <RoleSelect roles={roles} audience={audience} value={roleKey} onChange={setRoleKey} />
        <ScopeFields customerOrgId={customer ? user!.company_id : null} scopeType={scopeType} scopeId={scopeId} onType={setScopeType} onId={setScopeId} />
      </div>
    </Dialog>
  );
}

/** Users with their organization, state, roles and every admin action (Users page and organization page). */
export function UsersTable({ users, showOrganization = true, caption = 'Users' }: { users: UserDto[]; showOrganization?: boolean; caption?: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useRoles();
  const companies = useCompanies();
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [granting, setGranting] = useState<UserDto | null>(null);
  const [reissuing, setReissuing] = useState<UserDto | null>(null);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const [revoking, setRevoking] = useState<GrantDto | null>(null);
  const superAdmin = isSuperAdmin(me.grants);
  // Arnobot-wide accounts are managed by super-admins only (the API refuses otherwise).
  const mayManage = (u: UserDto) => superAdmin || !u.grants.some((g) => g.scope_type === 'platform' && !g.revoked_at);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['organizations'] });
  };
  const del = useMutation({
    mutationFn: (u: UserDto) => (u.deleted_at ? api.post(`/users/${u.id}/restore`) : api.del(`/users/${u.id}`)),
    onSuccess: (_x, u) => {
      toast.success(u.deleted_at ? 'User restored' : 'User deleted and signed out');
      setDeleting(null);
      invalidate();
    },
    onError: toast.error,
  });
  const revokeGrant = useMutation({
    mutationFn: (g: GrantDto) => api.post<UserDto>(`/grants/${g.id}/revoke`),
    onSuccess: () => {
      toast.success('Role revoked');
      setRevoking(null);
      invalidate();
    },
    onError: toast.error,
  });

  if (!users.length) return <EmptyState title="No users yet" description="Invite someone to give them a login." />;
  return (
    <>
      <DataTable
        caption={caption}
        rows={users}
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
                {u.id === me.id && (
                  <Badge tone="accent" className="ml-2">
                    You
                  </Badge>
                )}
                <span className="block text-xs text-muted">{u.email}</span>
              </span>
            ),
          },
          ...(showOrganization
            ? [
                {
                  key: 'o',
                  header: 'Organization',
                  cell: (u: UserDto) => (
                    <span className="flex items-center gap-1.5">
                      {u.company_name}
                      {u.company_kind === 'customer' && <Badge>Customer</Badge>}
                    </span>
                  ),
                },
              ]
            : []),
          {
            key: 's',
            header: 'State',
            cell: (u) =>
              u.deleted_at ? (
                <Badge tone="fault">Deleted</Badge>
              ) : !u.is_active ? (
                <Badge tone="offline">Disabled</Badge>
              ) : u.invite_pending ? (
                <Badge tone="warn" title={u.invite_expires_at ? `Link expires ${fmtDateTime(u.invite_expires_at)}` : undefined}>
                  Invited
                </Badge>
              ) : u.must_change_password ? (
                <Badge tone="warn">Temporary password</Badge>
              ) : (
                <Badge tone="ok">Active</Badge>
              ),
          },
          {
            key: 'g',
            header: 'Roles',
            className: 'min-w-64',
            cell: (u) => {
              const active = u.grants.filter((g) => !g.revoked_at);
              return active.length === 0 ? (
                <span className="text-xs text-muted">No roles: sees nothing</span>
              ) : (
                <ul className="flex flex-col gap-1">
                  {active.map((g) => (
                    <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge tone="accent">{g.role_name}</Badge>
                      <span>{scopeLabel(g, companies.data)}</span>
                      {!u.deleted_at && mayManage(u) && (g.scope_type !== 'platform' || superAdmin) && (
                        <button
                          type="button"
                          onClick={() => setRevoking(g)}
                          className="rounded p-0.5 text-muted hover:text-fault"
                          aria-label={`Revoke ${g.role_name} (${scopeLabel(g, companies.data)}) from ${u.name}`}
                        >
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
            cell: (u) =>
              !mayManage(u) ? (
                <span className="text-xs text-muted">Super-admin only</span>
              ) : (
                <span className="flex flex-wrap justify-end gap-1">
                  {!u.deleted_at && (
                    <>
                      <Button size="sm" variant="ghost" icon={<ShieldPlus className="size-3.5" aria-hidden />} onClick={() => setGranting(u)} aria-label={`Add role to ${u.name}`}>
                        Role
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`}>
                        Edit
                      </Button>
                      {u.id !== me.id && (
                        <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" aria-hidden />} onClick={() => setReissuing(u)} aria-label={`New credentials for ${u.name}`}>
                          {u.invite_pending ? 'Re-invite' : 'Credentials'}
                        </Button>
                      )}
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
      <EditUserDialog user={editing} onClose={() => setEditing(null)} isSelf={editing?.id === me.id} />
      <GrantDialog user={granting} onClose={() => setGranting(null)} roles={roles.data ?? []} />
      <ReissueDialog user={reissuing} onClose={() => setReissuing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting)}
        loading={del.isPending}
        danger
        title={`Delete ${deleting?.name ?? ''}?`}
        description="They are signed out everywhere and can no longer sign in. Soft delete: restorable. Recorded in the audit log."
        confirmLabel="Delete user"
      />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && revokeGrant.mutate(revoking)}
        loading={revokeGrant.isPending}
        danger
        title="Revoke role?"
        description={revoking ? `${revoking.role_name} · ${scopeLabel(revoking, companies.data)}. Takes effect on their next request.` : undefined}
        confirmLabel="Revoke"
      />
    </>
  );
}
