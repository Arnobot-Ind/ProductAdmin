'use client';

import type { UserDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { CreateUserDialog, useRoles, UsersTable } from '@/components/domain/user-admin';
import { Button } from '@/components/ui/button';
import { Checkbox, Select } from '@/components/ui/field';
import { InlineAlert, PageHeader, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/hooks';
import { useCompanies } from '@/lib/queries';

/** Every login, Arnobot staff and customer organizations alike: User → Role → Scope. */
export default function UsersPage() {
  useDocumentTitle('Users');
  const can = useCan();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [org, setOrg] = useState('');
  const [creating, setCreating] = useState(false);
  const companies = useCompanies(can('user.manage'));
  const roles = useRoles(can('user.manage'));
  const users = useQuery({
    queryKey: ['users', includeDeleted, org],
    queryFn: () => api.get<UserDto[]>('/users', { include_deleted: includeDeleted, company_id: org || undefined }),
    enabled: can('user.manage'),
  });

  if (!can('user.manage')) {
    return (
      <>
        <PageHeader title="Users" />
        <InlineAlert tone="fault">You don&apos;t have permission to manage users.</InlineAlert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Users"
        actions={
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
            Add user
          </Button>
        }
      />
      <div className="mb-2 flex flex-wrap items-center gap-3 [&_select]:w-auto!">
        <Select aria-label="Organization" value={org} onChange={(e) => setOrg(e.target.value)} className="h-9 w-56">
          <option value="">All organizations</option>
          {companies.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Checkbox label="Show deleted" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
      </div>
      <QueryView query={users}>{(list) => <UsersTable users={list} />}</QueryView>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} roles={roles.data ?? []} />
    </>
  );
}
