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

function ProfileDialog({ org, profile, onClose }: { org: OrganizationDetailDto; profile: ClientProfileDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const managers = useQuery({ queryKey: ['account-managers'], queryFn: () => api.get<UserRefDto[]>('/account-managers'), staleTime: 300_000 });
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
    mutationFn: () =>
      api.patch<ClientProfileDto>(`/organizations/${org.id}/profile`, {
        ...f,
        account_manager_id: f.account_manager_id || null,
        contract_start: f.contract_start || null,
        contract_end: f.contract_end || null,
        data_history_days: f.data_history_days ? Number(f.data_history_days) : null,
        data_from: f.data_from || null,
      }),
    onSuccess: () => {
      toast.success('Client profile saved');
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
      title={`Client profile of ${org.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={leaving ? 'danger' : 'primary'} onClick={() => m.mutate()} loading={m.isPending} disabled={codeBad || gstinBad || emailBad || datesBad || daysBad}>
            {leaving ? `Save and sign ${org.name} out` : 'Save'}
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Status" required hint="Onboarding and Active can sign in to the client app. Suspended and Ended cannot: their sessions end at once.">
          <Select value={f.status} onChange={(e) => set({ status: e.target.value as ClientStatus })} data-autofocus>
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
