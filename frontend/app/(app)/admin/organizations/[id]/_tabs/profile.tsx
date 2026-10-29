'use client';

import type { ClientProfileDto, ClientStatus, OrganizationDetailDto, UserRefDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { CLIENT_STATUS_LABEL, ClientStatusBadge } from '@/components/domain/client-admin';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, InlineAlert, KeyValue, Mono } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { CLIENT_STATUSES } from '@/lib/schema';

/** Client profile: status (who may sign in), contract, account manager and how much history the client sees. */
export function ClientProfileCard({ org, canEdit }: { org: OrganizationDetailDto; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const p = org.profile!;
  return (
    <>
      <Card
        title="Client profile"
        actions={
          canEdit &&
          !org.deleted_at && (
            <Button size="sm" icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(true)}>
              Edit profile
            </Button>
          )
        }
      >
        {p.status === 'suspended' || p.status === 'ended' ? (
          <div className="mb-4">
            <InlineAlert tone="warn" title={`${CLIENT_STATUS_LABEL[p.status]}: ${org.name}'s users cannot sign in`}>
              Their sessions were ended. Set the status back to Active to let them in again.
            </InlineAlert>
          </div>
        ) : null}
        <KeyValue
          columns={3}
          items={[
            { label: 'Status', value: <ClientStatusBadge status={p.status} /> },
            { label: 'Client code', value: p.client_code && <Mono>{p.client_code}</Mono> },
            { label: 'Account manager', value: p.account_manager && `${p.account_manager.name} · ${p.account_manager.email}` },
            { label: 'Contract', value: p.contract_start || p.contract_end ? `${fmtDate(p.contract_start)} – ${fmtDate(p.contract_end)}` : null },
            { label: 'Data history', value: p.data_history_days ? `Last ${p.data_history_days} days` : 'All history' },
            { label: 'Data visible from', value: p.data_from ? fmtDate(p.data_from) : 'The beginning' },
            { label: 'Legal name', value: p.legal_name },
            { label: 'Industry', value: p.industry },
            { label: 'Phone', value: p.phone },
            { label: 'Billing email', value: p.billing_email },
            { label: 'GSTIN', value: p.gstin && <Mono>{p.gstin}</Mono> },
            { label: 'Address', value: p.address },
          ]}
        />
        {!p.updated_at && <p className="mt-3 text-xs text-muted">No profile saved yet: these are the defaults.</p>}
      </Card>
      {editing && <ProfileDialog org={org} profile={p} onClose={() => setEditing(false)} />}
    </>
  );
}

/**
 * Edit everything about a customer organization in one place: name and contact, and the client profile
 * (status, code, manager, contract, data visibility, legal and billing details). Saves both in turn.
 */
export function ProfileDialog({ org, profile, onClose }: { org: OrganizationDetailDto; profile: ClientProfileDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const managers = useQuery({ queryKey: ['account-managers'], queryFn: () => api.get<UserRefDto[]>('/account-managers'), staleTime: 300_000 });
  const [basic, setBasic] = useState({ name: org.name, contact_name: org.contact_name ?? '', contact_email: org.contact_email ?? '', notes: org.notes ?? '' });
  const contactBad = !!basic.contact_email && !/\S+@\S+\.\S+/.test(basic.contact_email);
  const [f, setF] = useState({
    client_code: profile.client_code ?? '',
    status: profile.status,
    legal_name: profile.legal_name ?? '',
    industry: profile.industry ?? '',
    phone: profile.phone ?? '',
    address: profile.address ?? '',
    gstin: profile.gstin ?? '',
    billing_email: profile.billing_email ?? '',
    account_manager_id: profile.account_manager?.id ?? '',
    contract_start: profile.contract_start ?? '',
    contract_end: profile.contract_end ?? '',
    data_history_days: profile.data_history_days ? String(profile.data_history_days) : '',
    data_from: profile.data_from ?? '',
  });
  const m = useMutation({
    mutationFn: async () => {
      const changed =
        basic.name.trim() !== org.name || basic.contact_name.trim() !== (org.contact_name ?? '') || basic.contact_email.trim() !== (org.contact_email ?? '') || basic.notes.trim() !== (org.notes ?? '');
      if (changed)
        await api.patch(`/organizations/${org.id}`, {
          name: basic.name.trim(),
          contact_name: basic.contact_name.trim() || null,
          contact_email: basic.contact_email.trim() || null,
          notes: basic.notes.trim() || null,
        });
      return api.patch<ClientProfileDto>(`/organizations/${org.id}/profile`, {
        ...f,
        account_manager_id: f.account_manager_id || null,
        contract_start: f.contract_start || null,
        contract_end: f.contract_end || null,
        data_history_days: f.data_history_days ? Number(f.data_history_days) : null,
        data_from: f.data_from || null,
      });
    },
    onSuccess: () => {
      toast.success(`${basic.name.trim() || org.name} saved`);
      void qc.invalidateQueries({ queryKey: ['companies'] });
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      onClose();
    },
    onError: toast.error,
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const codeBad = !!f.client_code && !/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/.test(f.client_code);
  const gstinBad = !!f.gstin && !/^[0-9A-Za-z]{15}$/.test(f.gstin);
  const emailBad = !!f.billing_email && !/\S+@\S+\.\S+/.test(f.billing_email);
  const datesBad = !!f.contract_start && !!f.contract_end && f.contract_end < f.contract_start;
  const daysBad = !!f.data_history_days && !(Number.isInteger(Number(f.data_history_days)) && Number(f.data_history_days) > 0);
  const leaving = (f.status === 'suspended' || f.status === 'ended') && f.status !== profile.status;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Edit ${org.name}`}
      description="Everything about this organization. Changes are kept in the audit log."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={leaving ? 'danger' : 'primary'} onClick={() => m.mutate()} loading={m.isPending} disabled={!basic.name.trim() || contactBad || codeBad || gstinBad || emailBad || datesBad || daysBad}>
            {leaving ? `Save and sign ${org.name} out` : 'Save'}
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <h3 className="text-base font-semibold sm:col-span-2">Organization</h3>
        <Field label="Name" required className="sm:col-span-2">
          <Input value={basic.name} onChange={(e) => setBasic({ ...basic, name: e.target.value })} data-autofocus />
        </Field>
        <Field label="Contact person">
          <Input value={basic.contact_name} onChange={(e) => setBasic({ ...basic, contact_name: e.target.value })} />
        </Field>
        <Field label="Contact email" error={contactBad ? 'Not an email address' : null}>
          <Input type="email" value={basic.contact_email} onChange={(e) => setBasic({ ...basic, contact_email: e.target.value })} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={basic.notes} onChange={(e) => setBasic({ ...basic, notes: e.target.value })} />
        </Field>
        <h3 className="mt-2 border-t border-border pt-4 text-base font-semibold sm:col-span-2">Client account</h3>
        <Field label="Status" required hint="Onboarding and Active can sign in to the client app. Suspended and Ended cannot: their sessions end at once.">
          <Select value={f.status} onChange={(e) => set({ status: e.target.value as ClientStatus })}>
            {CLIENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CLIENT_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Client code" hint="2–32 letters, digits, - or _ (saved in capitals), e.g. ADANI." error={codeBad ? 'Not a valid code' : null}>
          <Input value={f.client_code} onChange={(e) => set({ client_code: e.target.value })} className="font-mono uppercase" />
        </Field>
        <Field label="Account manager" hint="The Arnobot person responsible for this client.">
          <Select value={f.account_manager_id} onChange={(e) => set({ account_manager_id: e.target.value })}>
            <option value="">None</option>
            {/* A current manager who is no longer an active Arnobot user still shows as the choice. */}
            {profile.account_manager && !managers.data?.some((u) => u.id === profile.account_manager!.id) && <option value={profile.account_manager.id}>{profile.account_manager.name}</option>}
            {managers.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Data history (days)"
          hint="Empty = all history. Otherwise the client's users see only robot data from the last N days."
          error={daysBad ? 'A whole number of days, at least 1' : null}
        >
          <Input type="number" min={1} value={f.data_history_days} onChange={(e) => set({ data_history_days: e.target.value })} placeholder="All history" />
        </Field>
        <Field label="Data visible from (IST)" hint="Empty = from the beginning. The client's users see no robot data recorded before this day; Arnobot staff still see all of it.">
          <Input type="date" value={f.data_from} onChange={(e) => set({ data_from: e.target.value })} />
        </Field>
        <Field label="Contract start">
          <Input type="date" value={f.contract_start} onChange={(e) => set({ contract_start: e.target.value })} />
        </Field>
        <Field label="Contract end" error={datesBad ? 'Ends before it starts' : null}>
          <Input type="date" value={f.contract_end} onChange={(e) => set({ contract_end: e.target.value })} />
        </Field>
        <h3 className="mt-2 border-t border-border pt-4 text-base font-semibold sm:col-span-2">Legal &amp; billing</h3>
        <Field label="Legal name">
          <Input value={f.legal_name} onChange={(e) => set({ legal_name: e.target.value })} />
        </Field>
        <Field label="Industry">
          <Input value={f.industry} onChange={(e) => set({ industry: e.target.value })} placeholder="Renewable energy" />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Billing email" error={emailBad ? 'Not an email address' : null}>
          <Input type="email" value={f.billing_email} onChange={(e) => set({ billing_email: e.target.value })} />
        </Field>
        <Field label="GSTIN" error={gstinBad ? '15 letters and digits' : null}>
          <Input value={f.gstin} onChange={(e) => set({ gstin: e.target.value })} className="font-mono uppercase" />
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Textarea rows={2} value={f.address} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        {leaving && (
          <div className="sm:col-span-2">
            <InlineAlert tone="warn">Every {org.name} user is signed out now and cannot sign in until the status is Onboarding or Active again.</InlineAlert>
          </div>
        )}
      </form>
    </Dialog>
  );
}
