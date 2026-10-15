'use client';

import type { OrganizationDetailDto, SoftwareInstallDto, SoftwareProductDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { LicenceBadge } from '@/components/domain/client-admin';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, Card, EmptyState, QueryView } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';

/** Arnobot software the client runs: versions, where it is installed, seats and licence dates. */
export function SoftwareTab({ org, canEdit }: { org: OrganizationDetailDto; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['organizations', org.id, 'software'], queryFn: () => api.get<SoftwareInstallDto[]>(`/organizations/${org.id}/software`) });
  const [editing, setEditing] = useState<SoftwareInstallDto | 'new' | null>(null);
  const [removing, setRemoving] = useState<SoftwareInstallDto | null>(null);
  const del = useMutation({
    mutationFn: (i: SoftwareInstallDto) => api.del(`/software-installs/${i.id}`),
    onSuccess: () => {
      toast.success('Install removed');
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: toast.error,
  });
  return (
    <Card
      title="Software and licences"
      actions={
        canEdit &&
        !org.deleted_at && (
          <Button size="sm" variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>
            Add install
          </Button>
        )
      }
    >
      <QueryView query={q}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState icon={<AppWindow className="size-8" />} title="No software recorded" description={`Record the Arnobot software ${org.name} runs (GCS, client portal, robot software) and its licences.`} />
          ) : (
            <DataTable
              caption={`Software of ${org.name}`}
              rows={list}
              rowKey={(i) => i.id}
              columns={[
                {
                  key: 's',
                  header: 'Software',
                  rowHeader: true,
                  cell: (i) => (
                    <span>
                      <span className="font-semibold">{i.software.name}</span>
                      {i.host_label && <span className="block text-xs text-muted">{i.host_label}</span>}
                    </span>
                  ),
                },
                {
                  key: 'v',
                  header: 'Version',
                  cell: (i) => (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono">{i.version}</span>
                      {i.update_available && (
                        <Badge tone="warn" title={`Latest is ${i.software.latest_version}`}>
                          update to {i.software.latest_version}
                        </Badge>
                      )}
                    </span>
                  ),
                },
                { key: 'r', header: 'Robot', cell: (i) => (i.robot_id ? <span className="font-mono">{i.robot_id}</span> : <span className="text-muted">—</span>) },
                { key: 'n', header: 'Seats', align: 'right', cell: (i) => i.seats ?? <span className="text-muted">—</span> },
                { key: 'i', header: 'Installed', cell: (i) => fmtDate(i.installed_at) },
                { key: 'l', header: 'Licence', cell: (i) => <LicenceBadge state={i.licence_state} until={i.licence_valid_until} /> },
                { key: 'o', header: 'Notes', className: 'max-w-xs', cell: (i) => <span className="block truncate text-xs text-muted" title={i.notes ?? undefined}>{i.notes ?? '—'}</span> },
                {
                  key: 'a',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  cell: (i) =>
                    canEdit && (
                      <span className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(i)} aria-label={`Edit ${i.software.name}`}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => setRemoving(i)} aria-label={`Remove ${i.software.name}`}>
                          Remove
                        </Button>
                      </span>
                    ),
                },
              ]}
            />
          )
        }
      </QueryView>
      <p className="mt-3 text-xs text-muted">Notes are for Arnobot only. The client app shows {org.name} its software, versions and licence dates without them.</p>
      {editing && <InstallDialog org={org} install={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && del.mutate(removing)}
        loading={del.isPending}
        danger
        title={`Remove ${removing?.software.name ?? ''}?`}
        description="The install is kept in the history and the audit log."
        confirmLabel="Remove"
      />
    </Card>
  );
}

function InstallDialog({ org, install, onClose }: { org: OrganizationDetailDto; install: SoftwareInstallDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const products = useQuery({ queryKey: ['software-products', false], queryFn: () => api.get<SoftwareProductDto[]>('/software-products'), staleTime: 60_000 });
  const [f, setF] = useState({
    software_id: install?.software.id ?? '',
    robot_id: install?.robot_id ?? '',
    version: install?.version ?? '',
    host_label: install?.host_label ?? '',
    seats: install?.seats ? String(install.seats) : '',
    installed_at: install?.installed_at ?? '',
    licence_valid_until: install?.licence_valid_until ?? '',
    notes: install?.notes ?? '',
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const body = {
    ...f,
    robot_id: f.robot_id || null,
    seats: f.seats ? Number(f.seats) : null,
    installed_at: f.installed_at || null,
    licence_valid_until: f.licence_valid_until || null,
  };
  const m = useMutation({
    mutationFn: () => (install ? api.patch<SoftwareInstallDto>(`/software-installs/${install.id}`, body) : api.post<SoftwareInstallDto>(`/organizations/${org.id}/software`, body)),
    onSuccess: () => {
      toast.success(install ? 'Install updated' : 'Install recorded');
      void qc.invalidateQueries({ queryKey: ['organizations'] });
      void qc.invalidateQueries({ queryKey: ['software-products'] });
      onClose();
    },
    onError: toast.error,
  });
  const picked = products.data?.find((p) => p.id === f.software_id);
  const seatsBad = !!f.seats && !(Number.isInteger(Number(f.seats)) && Number(f.seats) > 0);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={install ? `Edit ${install.software.name}` : `Record software at ${org.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!f.software_id || !f.version.trim() || seatsBad}>
            Save
          </Button>
        </>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} autoComplete="off">
        <Field label="Software" required hint={picked?.latest_version ? `Latest version: ${picked.latest_version}` : 'Add new software in Admin → Software.'}>
          <Select value={f.software_id} onChange={(e) => set({ software_id: e.target.value })} data-autofocus>
            <option value="">Choose…</option>
            {products.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Version" required>
          <Input value={f.version} onChange={(e) => set({ version: e.target.value })} className="font-mono" placeholder={picked?.latest_version ?? '1.0.0'} />
        </Field>
        <Field label="Robot" hint="Only robots this organization owns now.">
          <Select value={f.robot_id} onChange={(e) => set({ robot_id: e.target.value })}>
            <option value="">Not bound to a robot</option>
            {f.robot_id && !org.robots.some((r) => r.robot_id === f.robot_id) && <option value={f.robot_id}>{f.robot_id}</option>}
            {org.robots.map((r) => (
              <option key={r.robot_id} value={r.robot_id}>
                {r.robot_id}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Host" hint="Where it runs, e.g. Control room PC 2.">
          <Input value={f.host_label} onChange={(e) => set({ host_label: e.target.value })} />
        </Field>
        <Field label="Seats" error={seatsBad ? 'A whole number, at least 1' : null}>
          <Input type="number" min={1} value={f.seats} onChange={(e) => set({ seats: e.target.value })} />
        </Field>
        <Field label="Installed on">
          <Input type="date" value={f.installed_at} onChange={(e) => set({ installed_at: e.target.value })} />
        </Field>
        <Field label="Licence valid until" hint="Empty = perpetual or not licensed. Shown as expiring 30 days before.">
          <Input type="date" value={f.licence_valid_until} onChange={(e) => set({ licence_valid_until: e.target.value })} />
        </Field>
        <Field label="Notes" hint="Arnobot only; never shown to the client." className="sm:col-span-2">
          <Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </form>
    </Dialog>
  );
}
