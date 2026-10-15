'use client';

import type { UserAccessDto, UserDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { accessValid, AccessEditor, effectiveNames, useFeatureCatalogue, type AccessChoice } from '@/components/client/access-editor';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';
import { ErrorState, InlineAlert, LoadingBlock } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';

type Role = 'manager' | 'viewer';

/** A colleague's role, robots and features (GET / PUT /users/:id/access). Managers cannot change their own. */
export function AccessDialog({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const orgFeatures = me.client?.organization_features ?? [];
  const catalogue = useFeatureCatalogue();
  const q = useQuery({ queryKey: ['portal', 'access', user?.id], queryFn: () => api.get<UserAccessDto>(`/users/${user!.id}/access`), enabled: !!user });
  const [role, setRole] = useState<Role>('viewer');
  const [choice, setChoice] = useState<AccessChoice>({ robots: 'all', features: [] });
  useEffect(() => {
    if (!q.data) return;
    setRole(q.data.role_key === 'manager' ? 'manager' : 'viewer');
    setChoice({ robots: q.data.robots, features: q.data.features });
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.put<UserAccessDto>(`/users/${user!.id}/access`, { role_key: role, robots: choice.robots, features: choice.features }),
    onSuccess: () => {
      toast.success(`Access of ${user!.name} saved`);
      void qc.invalidateQueries({ queryKey: ['portal', 'team'] });
      void qc.invalidateQueries({ queryKey: ['portal', 'access', user!.id] });
      onClose();
    },
    onError: toast.error,
  });
  const effective = effectiveNames(catalogue.data, choice.features, orgFeatures);

  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      size="lg"
      title={`Access · ${user?.name ?? ''}`}
      description={user?.email}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!q.data || !accessValid(choice)}>
            Save access
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <LoadingBlock rows={5} label="Loading access" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          <RoleField role={role} onChange={setRole} />
          <AccessEditor value={choice} onChange={setChoice} organizationFeatures={orgFeatures} />
          <InlineAlert tone="accent" title="They will see">
            {effective.join(' · ')}
          </InlineAlert>
        </div>
      )}
    </Dialog>
  );
}

export function RoleField({ role, onChange, className }: { role: Role; onChange: (r: Role) => void; className?: string }) {
  return (
    <Field label="Role" className={className} hint={role === 'manager' ? 'Also invites colleagues and sets their access.' : 'Sees what you give them below.'}>
      <Select value={role} onChange={(e) => onChange(e.target.value as Role)}>
        <option value="viewer">Viewer</option>
        <option value="manager">Manager</option>
      </Select>
    </Field>
  );
}
