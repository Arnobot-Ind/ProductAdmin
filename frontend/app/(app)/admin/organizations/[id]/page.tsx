'use client';

import type { OrganizationDetailDto, OrganizationDto, Paginated, RobotListItemDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Link2, Pencil, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { OrganizationDialog } from '@/components/domain/organization-dialog';
import { CreateUserDialog, useRoles, UsersTable } from '@/components/domain/user-admin';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge, Card, EmptyState, InlineAlert, KeyValue, Mono, QueryView, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';

export default function OrganizationPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const q = useQuery({ queryKey: ['organizations', id], queryFn: () => api.get<OrganizationDetailDto>(`/organizations/${id}`), enabled: can('org.manage') });
  if (!can('org.manage')) return <InlineAlert tone="fault">You don&apos;t have permission to manage organizations.</InlineAlert>;
  return <QueryView query={q} rows={8}>{(org) => <OrganizationView org={org} />}</QueryView>;
}

function OrganizationView({ org }: { org: OrganizationDetailDto }) {
  useDocumentTitle(org.name);
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const roles = useRoles(can('user.manage'));
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = useMutation({
    mutationFn: () => (org.deleted_at ? api.post<OrganizationDto>(`/organizations/${org.id}/restore`) : api.del<OrganizationDto>(`/organizations/${org.id}`)),
    onSuccess: () => {
      toast.success(org.deleted_at ? `${org.name} restored` : `${org.name} deleted`);
      setDeleting(false);
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      void qc.invalidateQueries({ queryKey: ['companies'] });
      if (!org.deleted_at) router.push('/admin/organizations');
    },
    onError: toast.error,
  });
  const customer = org.kind === 'customer';

  return (
    <div className="flex flex-col gap-5">
      <div>
        <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
          <Link href="/admin/organizations" className="hover:underline">
            Organizations
          </Link>{' '}
          / <span aria-current="page">{org.name}</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold">{org.name}</h1>
            {customer ? <Badge>Customer</Badge> : <Badge tone="accent">Arnobot (internal)</Badge>}
            {org.deleted_at && <Badge tone="fault">Deleted</Badge>}
          </div>
          <div className="flex flex-wrap gap-2">
            {!org.deleted_at && (
              <Button icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {customer && (
              <Button
                variant={org.deleted_at ? 'secondary' : 'ghost'}
                icon={org.deleted_at ? <RotateCcw className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                onClick={() => (org.deleted_at ? del.mutate() : setDeleting(true))}
                loading={del.isPending}
              >
                {org.deleted_at ? 'Restore' : 'Delete'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Card title="Details">
        <KeyValue
          columns={3}
          items={[
            { label: 'Contact', value: org.contact_name },
            { label: 'Email', value: org.contact_email },
            { label: 'Created', value: <Time iso={org.created_at} /> },
            { label: 'Notes', value: org.notes },
          ]}
        />
      </Card>

      <Card
        title={`Robots (${org.robots.length})`}
        actions={
          can('ownership.write') &&
          !org.deleted_at && (
            <Button size="sm" variant="primary" icon={<Link2 className="size-4" aria-hidden />} onClick={() => setAssigning(true)}>
              Assign robot
            </Button>
          )
        }
        bodyClassName="p-0"
      >
        {org.robots.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Bot className="size-8" />}
              title="No robots assigned"
              description={customer ? `Assign a robot and ${org.name}'s users will see it and its data.` : 'Robots return here when they are not assigned to a customer.'}
            />
          </div>
        ) : (
          <DataTable
            caption={`Robots of ${org.name}`}
            rows={org.robots}
            rowKey={(r) => r.robot_id}
            columns={[
              {
                key: 'r',
                header: 'Robot',
                rowHeader: true,
                cell: (r) => (
                  <Link href={`/robots/${r.robot_id}`} className="font-mono font-semibold text-accent-text hover:underline">
                    {r.robot_id}
                  </Link>
                ),
              },
              { key: 'p', header: 'Product', cell: (r) => r.product_name },
              { key: 's', header: 'Serial', cell: (r) => <Mono>{r.serial_number}</Mono> },
              { key: 'st', header: 'Status', cell: (r) => <Badge tone={r.status === 'online' ? 'ok' : r.status === 'stale' ? 'warn' : 'offline'}>{r.status}</Badge> },
              { key: 'a', header: 'Assigned since', cell: (r) => <Time iso={r.assigned_since} /> },
            ]}
          />
        )}
      </Card>

      <Card
        title={`Users (${org.users.length})`}
        actions={
          can('user.manage') &&
          !org.deleted_at && (
            <Button size="sm" variant="primary" icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setInviting(true)}>
              {customer ? `Invite ${org.name} user` : 'Add Arnobot user'}
            </Button>
          )
        }
      >
        {can('user.manage') ? <UsersTable users={org.users} showOrganization={false} caption={`Users of ${org.name}`} /> : <p className="text-sm text-muted">Managing users needs the user.manage permission.</p>}
      </Card>

      {editing && <OrganizationDialog open onClose={() => setEditing(false)} org={org} />}
      <AssignRobotDialog open={assigning} onClose={() => setAssigning(false)} org={org} />
      <CreateUserDialog open={inviting} onClose={() => setInviting(false)} roles={roles.data ?? []} organization={{ id: org.id, name: org.name, kind: org.kind }} />
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => del.mutate()}
        loading={del.isPending}
        danger
        title={`Delete ${org.name}?`}
        description="Only possible when it has no robots and no users. Restorable."
        confirmLabel="Delete organization"
      />
    </div>
  );
}

function AssignRobotDialog({ open, onClose, org }: { open: boolean; onClose: () => void; org: OrganizationDetailDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const robots = useQuery({ queryKey: ['robots', 'options'], queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { limit: 200 }), enabled: open, staleTime: 60_000 });
  const [robotId, setRobotId] = useState('');
  const [reason, setReason] = useState('');
  const owned = new Set(org.robots.map((r) => r.robot_id));
  const options = (robots.data?.items ?? []).filter((r) => !owned.has(r.robot_id) && !r.deleted_at);
  const m = useMutation({
    mutationFn: () =>
      api.post(`/organizations/${org.id}/robots`, { robot_id: robotId, reason: reason.trim() || null }),
    onSuccess: () => {
      toast.success(`${robotId} assigned to ${org.name}`);
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      void qc.invalidateQueries({ queryKey: ['robots'] });
      setRobotId('');
      setReason('');
      onClose();
    },
    onError: toast.error,
  });
  const picked = options.find((r) => r.robot_id === robotId);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Assign a robot to ${org.name}`}
      description="Ends the robot's current assignment (history is kept) and gives it to this organization."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!robotId}>
            Assign
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Robot" required hint={picked ? `Currently with ${picked.owner_company ?? 'nobody'}.` : undefined}>
          <Select value={robotId} onChange={(e) => setRobotId(e.target.value)} data-autofocus>
            <option value="">Choose…</option>
            {options.map((r) => (
              <option key={r.robot_id} value={r.robot_id}>
                {r.robot_id} · {r.product_name} · now with {r.owner_company ?? 'nobody'}
              </option>
            ))}
          </Select>
        </Field>
        <InlineAlert tone="accent">
          {org.name} will see this robot and its data: everything recorded for it except while another customer owned it.
        </InlineAlert>
        <Field label="Reason" hint="Kept in the ownership history and the audit log.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Delivered under PO 4500123" />
        </Field>
        {picked?.owner_company && picked.owner_company !== 'Arnobot' && (
          <InlineAlert tone="warn">
            {picked.owner_company} will lose access to {picked.robot_id} immediately, and {org.name} will not see what was recorded for {picked.owner_company}. Robot-level roles{' '}
            {picked.owner_company}&apos;s users held on it are revoked.
          </InlineAlert>
        )}
      </div>
    </Dialog>
  );
}
