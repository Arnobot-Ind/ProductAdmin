'use client';

import type { CompanyDto, OwnershipDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge, EmptyState, InlineAlert, QueryView, Time } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { fromLocalInput } from '@/lib/format';

/** Spec §3 row 2: ownership is history (from / to), never a single mutable company field. */
export function OwnershipTab({ robotId }: { robotId: string }) {
  const can = useCan();
  const [transferring, setTransferring] = useState(false);
  const q = useQuery({ queryKey: ['robot', robotId, 'ownership'], queryFn: () => api.get<OwnershipDto[]>(`/robots/${robotId}/ownership`) });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">In v1 every robot belongs to Arnobot. Rental and customer ownership later is just a new period here.</p>
        {can('ownership.write') && (
          <Button icon={<ArrowRightLeft className="size-4" aria-hidden />} onClick={() => setTransferring(true)}>
            Transfer
          </Button>
        )}
      </div>
      <QueryView query={q}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="No ownership recorded" />
          ) : (
            <ol className="relative flex flex-col gap-4 border-l-2 border-border pl-5" aria-label="Ownership history, newest first">
              {rows.map((o) => (
                <li key={o.id} className="relative">
                  <span className={`absolute top-1.5 -left-[1.6rem] size-3 rounded-full border-2 border-surface ${o.valid_to ? 'bg-offline' : 'bg-ok'}`} aria-hidden />
                  <div className="rounded-md border border-border bg-surface p-3">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {o.company_name}
                      {!o.valid_to && <Badge tone="ok">Current owner</Badge>}
                    </p>
                    <p className="mt-1 text-sm">
                      From <Time iso={o.valid_from} /> {o.valid_to ? <>to <Time iso={o.valid_to} /></> : 'until now'}
                    </p>
                    {(o.reason || o.created_by_name) && (
                      <p className="mt-1 text-xs text-muted">
                        {o.reason}
                        {o.reason && o.created_by_name ? ' · ' : ''}
                        {o.created_by_name ? `recorded by ${o.created_by_name}` : ''}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )
        }
      </QueryView>
      <TransferDialog robotId={robotId} open={transferring} onClose={() => setTransferring(false)} />
    </div>
  );
}

function TransferDialog({ robotId, open, onClose }: { robotId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<CompanyDto[]>('/companies'), enabled: open });
  const [companyId, setCompanyId] = useState('');
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<OwnershipDto[]>(`/robots/${robotId}/ownership`, { company_id: companyId, reason: reason.trim() || undefined, valid_from: fromLocalInput(from) }),
    onSuccess: () => {
      toast.success('Ownership transferred');
      void qc.invalidateQueries({ queryKey: ['robot', robotId] });
      void qc.invalidateQueries({ queryKey: ['robots'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Transfer ownership"
      description="Closes the current ownership period and opens a new one. Nothing is overwritten."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!companyId}>
            Transfer
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {companies.data && companies.data.length <= 1 && <InlineAlert tone="accent">Only one company (Arnobot) exists in v1. Customers are added later as data.</InlineAlert>}
        <Field label="New owner" required>
          <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} data-autofocus>
            <option value="">Choose…</option>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Effective from (local)" hint="Leave empty for now.">
          <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rental to customer, pilot" />
        </Field>
      </div>
    </Dialog>
  );
}
