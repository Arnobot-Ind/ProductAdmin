'use client';

import type { OrganizationDto } from '@arnobot/message-schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

/** Create (no `org`) or edit an organization. */
export function OrganizationDialog({ open, onClose, org }: { open: boolean; onClose: () => void; org?: OrganizationDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const [f, setF] = useState({ name: org?.name ?? '', contact_name: org?.contact_name ?? '', contact_email: org?.contact_email ?? '', notes: org?.notes ?? '' });
  const m = useMutation({
    mutationFn: () => (org ? api.patch<OrganizationDto>(`/organizations/${org.id}`, f) : api.post<OrganizationDto>('/organizations', f)),
    onSuccess: (o) => {
      toast.success(org ? 'Organization updated' : `${o.name} created`);
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      void qc.invalidateQueries({ queryKey: ['companies'] });
      onClose();
      if (!org) router.push(`/admin/organizations/${o.id}`);
    },
    onError: toast.error,
  });
  const emailBad = !!f.contact_email && !/\S+@\S+\.\S+/.test(f.contact_email);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={org ? `Edit ${org.name}` : 'New customer organization'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!f.name.trim() || emailBad}>
            {org ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()}>
        <Field label="Name" required className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Adani" data-autofocus />
        </Field>
        <Field label="Contact person">
          <Input value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} />
        </Field>
        <Field label="Contact email" error={emailBad ? 'Not an email address' : null}>
          <Input type="email" value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </form>
    </Dialog>
  );
}
