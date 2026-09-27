'use client';

import type { HardwareRevisionDto, ProductDto, RobotDetailDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RobotStatusBadge } from '@/components/domain/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, InlineAlert, Mono, QueryView } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';
import { ConnectivityTab } from './_tabs/connectivity';
import { CredentialsTab } from './_tabs/credentials';
import { DispatchTab } from './_tabs/dispatch';
import { DocumentsTab } from './_tabs/documents';
import { HardwareTab } from './_tabs/hardware';
import { MaintenanceTab } from './_tabs/maintenance';
import { RobotEventsTab, RobotMissionsTab } from './_tabs/lists';
import { OverviewTab } from './_tabs/overview';
import { OwnershipTab } from './_tabs/ownership';
import { SoftwareTab } from './_tabs/software';
import { TelemetryTab } from './_tabs/telemetry';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'missions', label: 'Missions' },
  { id: 'events', label: 'Events' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'software', label: 'Software' },
  { id: 'connectivity', label: 'Connectivity' },
  { id: 'credentials', label: 'Credentials', perm: 'credential.read_meta' },
  { id: 'documents', label: 'Documents' },
  { id: 'dispatch', label: 'Dispatch & warranty' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'ownership', label: 'Ownership' },
] as const;

export default function RobotDetailPage() {
  const { robotId } = useParams<{ robotId: string }>();
  useDocumentTitle(robotId);
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['robot', robotId, 'detail'],
    queryFn: () => api.get<RobotDetailDto>(`/robots/${robotId}`),
    refetchInterval: poll,
  });
  return <QueryView query={q} rows={8}>{(r) => <RobotDetail robot={r} />}</QueryView>;
}

function RobotDetail({ robot }: { robot: RobotDetailDto }) {
  const can = useCan();
  const [params, setParams] = useUrlState();
  const tabs = TABS.filter((t) => !('perm' in t) || can(t.perm));
  const requested = params.get('tab') ?? 'overview';
  const tab = tabs.some((t) => t.id === requested) ? requested : 'overview';
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();

  const del = useMutation({
    mutationFn: () => (robot.deleted_at ? api.post(`/robots/${robot.robot_id}/restore`) : api.del(`/robots/${robot.robot_id}`)),
    onSuccess: () => {
      toast.success(robot.deleted_at ? 'Robot restored' : 'Robot deleted. Its ID stays reserved and it can be restored.');
      setDeleting(false);
      void qc.invalidateQueries({ queryKey: ['robot', robot.robot_id] });
      void qc.invalidateQueries({ queryKey: ['robots'] });
    },
    onError: toast.error,
  });

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm text-muted">
        <Link href="/robots" className="hover:underline">
          Robots
        </Link>{' '}
        / <span aria-current="page">{robot.robot_id}</span>
      </nav>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-2xl font-bold">{robot.robot_id}</h1>
            <RobotStatusBadge lastSeenAt={robot.last_seen_at} showAge />
            {robot.deleted_at && <Badge tone="fault">Deleted</Badge>}
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <div className="flex gap-1.5">
              <dt className="text-muted">Product</dt>
              <dd>{robot.product_name}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">Revision</dt>
              <dd>{robot.hardware_revision ?? 'Not set'}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">Serial</dt>
              <dd>
                <Mono>{robot.serial_number}</Mono>
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">Owner</dt>
              <dd>{robot.owner_company ?? '—'}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-muted">Current mission</dt>
              <dd>
                {robot.current_mission_id ? (
                  <Link href={`/missions/${encodeURIComponent(robot.current_mission_id)}`} className="font-mono text-accent-text hover:underline">
                    {robot.current_mission_id}
                  </Link>
                ) : (
                  'None'
                )}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('robot.write') && !robot.deleted_at && (
            <Button icon={<Pencil className="size-4" aria-hidden />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {can('robot.delete') &&
            (robot.deleted_at ? (
              <Button icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => del.mutate()} loading={del.isPending}>
                Restore
              </Button>
            ) : (
              <Button variant="ghost" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setDeleting(true)}>
                Delete
              </Button>
            ))}
        </div>
      </header>

      {robot.deleted_at && (
        <div className="mb-4">
          <InlineAlert tone="fault">This robot is deleted. Its data is kept, and its Robot ID is never reused. Restore it to accept messages again.</InlineAlert>
        </div>
      )}

      <Tabs label="Robot record sections" items={tabs.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={(id) => setParams({ tab: id === 'overview' ? null : id })} />
      <TabPanel id={tab}>
        {tab === 'overview' && <OverviewTab robot={robot} />}
        {tab === 'telemetry' && <TelemetryTab robotId={robot.robot_id} />}
        {tab === 'missions' && <RobotMissionsTab robotId={robot.robot_id} />}
        {tab === 'events' && <RobotEventsTab robotId={robot.robot_id} />}
        {tab === 'hardware' && <HardwareTab robotId={robot.robot_id} />}
        {tab === 'software' && <SoftwareTab robotId={robot.robot_id} />}
        {tab === 'connectivity' && <ConnectivityTab robotId={robot.robot_id} />}
        {tab === 'credentials' && <CredentialsTab robotId={robot.robot_id} />}
        {tab === 'documents' && <DocumentsTab robot={robot} />}
        {tab === 'dispatch' && <DispatchTab robotId={robot.robot_id} />}
        {tab === 'maintenance' && <MaintenanceTab robotId={robot.robot_id} />}
        {tab === 'ownership' && <OwnershipTab robotId={robot.robot_id} />}
      </TabPanel>

      <EditRobotDialog robot={robot} open={editing} onClose={() => setEditing(false)} />
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => del.mutate()}
        loading={del.isPending}
        danger
        title={`Delete ${robot.robot_id}?`}
        description="The robot is marked deleted (soft delete). All history is kept, the Robot ID is never reused, and it can be restored. Messages from a deleted robot are rejected."
        confirmLabel="Delete robot"
      />
    </>
  );
}

function EditRobotDialog({ robot, open, onClose }: { robot: RobotDetailDto; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [serial, setSerial] = useState(robot.serial_number);
  const [revisionId, setRevisionId] = useState(robot.hardware_revision_id ?? '');
  const [notes, setNotes] = useState(robot.notes ?? '');
  const product = useQuery({
    queryKey: ['product', robot.product_id],
    queryFn: () => api.get<ProductDto & { revisions: HardwareRevisionDto[] }>(`/products/${robot.product_id}`),
    enabled: open,
  });
  const m = useMutation({
    mutationFn: () =>
      api.patch<RobotDetailDto>(`/robots/${robot.robot_id}`, {
        serial_number: serial.trim(),
        hardware_revision_id: revisionId || null,
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Robot updated');
      void qc.invalidateQueries({ queryKey: ['robot', robot.robot_id] });
      void qc.invalidateQueries({ queryKey: ['robots'] });
      onClose();
    },
    onError: toast.error,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Edit ${robot.robot_id}`}
      description="The Robot ID and product are permanent and cannot be edited."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending} disabled={!serial.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Serial number" required hint="Correct only if it was entered wrongly. It never stands in for the Robot ID.">
          <Input value={serial} onChange={(e) => setSerial(e.target.value)} data-autofocus />
        </Field>
        <Field label="Hardware revision">
          <Select value={revisionId} onChange={(e) => setRevisionId(e.target.value)}>
            <option value="">Not set</option>
            {product.data?.revisions.filter((r) => !r.deleted_at || r.id === robot.hardware_revision_id).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
}
