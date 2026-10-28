'use client';

import type { UserCredentialsDto, UserDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2, Power, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { AccessDialog } from '@/components/client/team-access';
import { InviteDialog, InviteLinkDialog } from '@/components/client/team-invite';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, InlineAlert, PageHeader, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCanAnywhere, useMe } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

const fmtIst = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never';

function Status({ u }: { u: UserDto }) {
  if (!u.is_active) return <Badge tone="offline">Disabled</Badge>;
  if (u.invite_pending) {
    const expired = u.invite_expires_at !== null && Date.parse(u.invite_expires_at) < Date.now();
    return expired ? <Badge tone="fault">Invite expired</Badge> : <Badge tone="warn" title={`Link expires ${fmtIst(u.invite_expires_at)} IST`}>Invite pending</Badge>;
  }
  return <Badge tone="ok">Active</Badge>;
}

/** All robots (an organization grant) or how many were chosen (robot grants). */
function robotsLabel(u: UserDto) {
  const grants = u.grants.filter((g) => !g.revoked_at);
  if (grants.some((g) => g.scope_type === 'company')) return 'All';
  const robots = grants.filter((g) => g.scope_type === 'robot').map((g) => g.scope_id!.toUpperCase());
  return robots.length ? robots.join(', ') : <span className="text-muted">None</span>;
}

/**
 * The customer Manager's team (user.invite, 0020): colleagues of their own organization, invitations by one-time
 * link, access (role, robots and features per colleague, 0021), disable / remove. The API keeps every call inside the Manager's organization.
 */
export default function TeamPage() {
  useDocumentTitle('Team');
  const me = useMe();
  const canAnywhere = useCanAnywhere();
  const manager = canAnywhere('user.invite') || canAnywhere('user.manage');
  const qc = useQueryClient();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<UserCredentialsDto | null>(null);
  const [removing, setRemoving] = useState<UserDto | null>(null);
  const [access, setAccess] = useState<UserDto | null>(null);

  const users = useQuery({
    queryKey: ['portal', 'team'],
    // An Arnobot admin previewing the portal sees the organization they belong to, like a Manager would.
    queryFn: () => api.get<UserDto[]>('/users', { company_id: me.organization.id }),
    enabled: manager,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['portal', 'team'] });

  const reissue = useMutation({
    mutationFn: (u: UserDto) => api.post<UserCredentialsDto>(`/users/${u.id}/credentials`, { method: 'invite' }),
    onSuccess: (r) => {
      refresh();
      setLink(r);
    },
    onError: toast.error,
  });
  const toggle = useMutation({
    mutationFn: (u: UserDto) => api.patch<UserDto>(`/users/${u.id}`, { is_active: !u.is_active }),
    onSuccess: (u) => {
      toast.success(u.is_active ? `${u.name} can sign in again` : `${u.name} is disabled and signed out`);
      refresh();
    },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: (u: UserDto) => api.del(`/users/${u.id}`),
    onSuccess: () => {
      toast.success('Removed and signed out');
      setRemoving(null);
      refresh();
    },
    onError: toast.error,
  });

  if (!manager) {
    return (
      <>
        <PageHeader title="Team" />
        <InlineAlert tone="accent">Only Managers can manage your team. Ask a Manager at {me.organization.name} to invite a colleague.</InlineAlert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Team"
        description={`People at ${me.organization.name} who can sign in to the Arnobot portal. Invite a colleague: they get a one-time link and choose their own password.`}
        actions={
          <Button variant="primary" icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setInviting(true)}>
            Invite colleague
          </Button>
        }
      />
      <QueryView query={users}>
        {(list) => (
          <DataTable
            caption="Team members"
            rows={list}
            rowKey={(u) => u.id}
            columns={[
              {
                key: 'name',
                header: 'Name',
                rowHeader: true,
                cell: (u) => (
                  <span className="flex flex-col">
                    <span className="font-medium">
                      {u.name}
                      {u.id === me.id && <span className="ml-1.5 text-xs font-normal text-muted">(you)</span>}
                    </span>
                    <span className="text-xs text-muted">{u.email}</span>
                  </span>
                ),
              },
              { key: 'role', header: 'Role', cell: (u) => [...new Set(u.grants.filter((g) => !g.revoked_at).map((g) => g.role_name))].join(', ') || <span className="text-muted">No role</span> },
              { key: 'robots', header: 'Robots', cell: (u) => robotsLabel(u) },
              { key: 'status', header: 'Status', cell: (u) => <Status u={u} /> },
              { key: 'login', header: 'Last sign-in (IST)', cell: (u) => fmtIst(u.last_login_at) },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                align: 'right',
                cell: (u) =>
                  u.id === me.id ? null : (
                    <span className="inline-flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" icon={<KeyRound className="size-4" aria-hidden />} onClick={() => setAccess(u)}>
                        Access
                      </Button>
                      {u.is_active && (
                        <Button size="sm" icon={<Link2 className="size-4" aria-hidden />} onClick={() => reissue.mutate(u)} loading={reissue.isPending && reissue.variables?.id === u.id}>
                          New invite link
                        </Button>
                      )}
                      <Button size="sm" icon={<Power className="size-4" aria-hidden />} onClick={() => toggle.mutate(u)} loading={toggle.isPending && toggle.variables?.id === u.id}>
                        {u.is_active ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setRemoving(u)}>
                        Remove
                      </Button>
                    </span>
                  ),
              },
            ]}
          />
        )}
      </QueryView>

      <InviteDialog open={inviting} onClose={() => setInviting(false)} onInvited={setLink} />
      <InviteLinkDialog result={link} onClose={() => setLink(null)} />
      <AccessDialog user={access} onClose={() => setAccess(null)} />
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
        loading={remove.isPending}
        danger
        title={`Remove ${removing?.name ?? ''}?`}
        description="They are signed out and can no longer sign in. Arnobot can restore the account if needed."
        confirmLabel="Remove"
      />
    </>
  );
}
