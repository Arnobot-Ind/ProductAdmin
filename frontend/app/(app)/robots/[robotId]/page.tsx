'use client';

import type { HardwareRevisionDto, ProductDto, RobotDetailDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { missionHref } from '@/components/domain/missions-table';
import { RobotStatusBadge } from '@/components/domain/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, InlineAlert, Mono, QueryView } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';
import { ConnectivityTab } from './_tabs/connectivity';
import { DetectionsTab } from '@/components/domain/detections';
import { IngestClientsPanel } from '@/components/domain/ingest-clients';
import { CredentialsTab } from './_tabs/credentials';
import { DispatchTab } from './_tabs/dispatch';
import { DocumentsTab } from './_tabs/documents';
import { HardwareTab } from './_tabs/hardware';
import { MaintenanceTab } from './_tabs/maintenance';
import { RobotEventsTab, RobotMissionsTab } from './_tabs/lists';
import { HealthTab, LocationTab, MissionStatsCard, OverviewTab, RobotMonthCharts } from './_tabs/overview';
import { RobotLogTab } from './_tabs/log';
import { OwnershipTab } from './_tabs/ownership';
import { SoftwareTab } from './_tabs/software';
import { TelemetryTab } from './_tabs/telemetry';
import { VideosTab } from './_tabs/videos';
import { DataActivityBadge } from '@/components/archive/badges';

/**
 * The robot record in five sections, each with a few views (?tab= keeps the view's id, so old links still work).
 * Status = what it is doing now; Recordings = what it captured; Hardware / Software = how it is built;
 * Records = paperwork and history; Logs = everything above in one timeline.
 */
const SECTIONS: { id: string; label: string; tabs: { id: string; label: string; perm?: string }[] }[] = [
  {
    id: 'status',
    label: 'Live status',
    tabs: [
      { id: 'overview', label: 'Summary' },
      { id: 'location', label: 'Location' },
      { id: 'health', label: 'Health' },
      { id: 'telemetry', label: 'Sensor history' },
      { id: 'connectivity', label: 'Connectivity' },
    ],
  },
  {
    id: 'recordings',
    label: 'Recordings',
    tabs: [
      { id: 'videos', label: 'Videos' },
      { id: 'detections', label: 'Detections' },
      { id: 'missions', label: 'Missions' },
      { id: 'events', label: 'Events' },
    ],
  },
  {
    id: 'hardware',
    label: 'Hardware',
    tabs: [
      { id: 'hardware', label: 'Parts fitted' },
      { id: 'maintenance', label: 'Maintenance' },
      { id: 'dispatch', label: 'Dispatch & warranty' },
    ],
  },
  {
    id: 'software',
    label: 'Software',
    tabs: [
      { id: 'software', label: 'Installed software' },
      { id: 'credentials', label: 'Credentials', perm: 'credential.read_meta' },
      { id: 'keys', label: 'Robot & GCS keys', perm: 'ingest.manage' },
    ],
  },
  {
    id: 'records',
    label: 'Records',
    tabs: [
      { id: 'documents', label: 'Documents' },
      { id: 'ownership', label: 'Ownership' },
    ],
  },
  {
    id: 'logs',
    label: 'Logs',
    tabs: [{ id: 'log', label: 'Activity log' }],
  },
];

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
  const sections = SECTIONS.map((sec) => ({ ...sec, tabs: sec.tabs.filter((t) => !t.perm || can(t.perm)) })).filter((sec) => sec.tabs.length);
  const requested = params.get('tab') ?? 'overview';
  const tab = sections.some((sec) => sec.tabs.some((t) => t.id === requested)) ? requested : 'overview';
  const section = sections.find((sec) => sec.tabs.some((t) => t.id === tab))!;
  const openTab = (id: string) => setParams({ tab: id === 'overview' ? null : id });
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
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
        <Link href="/robots" className="hover:underline">
          Robots
        </Link>{' '}
        / <span aria-current="page">{robot.robot_id}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-3xl font-bold">{robot.robot_id}</h1>
            <RobotStatusBadge lastSeenAt={robot.last_seen_at} showAge />
            <DataActivityBadge lastSeenAt={robot.last_seen_at} lastUploadAt={robot.last_upload_at} sendingData={robot.sending_data} recording={robot.recording} />
            {robot.deleted_at && <Badge tone="fault">Deleted</Badge>}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-sm sm:grid-cols-3 xl:grid-cols-5">
            <div className="min-w-0">
              <dt className="text-sm text-muted">Product</dt>
              <dd className="mt-0.5 font-semibold">{robot.product_name}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-muted">Revision</dt>
              <dd className="mt-0.5 font-semibold">{robot.hardware_revision ?? 'Not set'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-muted">Serial</dt>
              <dd className="mt-0.5">
                <Mono>{robot.serial_number}</Mono>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-muted">Owner</dt>
              <dd className="mt-0.5 font-semibold">{robot.owner_company ?? '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-muted">Current mission</dt>
              <dd className="mt-0.5 font-semibold">
                {robot.current_mission_id ? (
                  <Link href={missionHref({ robot_id: robot.robot_id, mission_id: robot.current_mission_id })} className={cn('text-accent-text hover:underline', !robot.current_mission_name && 'font-mono')} title={robot.current_mission_id}>
                    {robot.current_mission_name ?? robot.current_mission_id}
                  </Link>
                ) : (
                  'None'
                )}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-wrap gap-2 empty:hidden">
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

      <Tabs label="Robot record sections" items={sections.map((sec) => ({ id: sec.id, label: sec.label }))} value={section.id} onChange={(id) => openTab(sections.find((sec) => sec.id === id)!.tabs[0].id)} />
      {section.tabs.length > 1 && (
        <div role="group" aria-label={`${section.label} views`} className="mt-4 flex flex-wrap gap-2">
          {section.tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === tab}
              onClick={() => openTab(t.id)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm font-medium',
                t.id === tab ? 'border-accent bg-accent-soft text-accent-text' : 'border-border bg-surface text-muted hover:border-accent/50 hover:text-fg',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <TabPanel id={section.id} className="pt-5">
        {tab === 'overview' && <OverviewTab robot={robot} />}
        {tab === 'location' && <LocationTab robot={robot} />}
        {tab === 'health' && <HealthTab robot={robot} />}
        {tab === 'videos' && <VideosTab robotId={robot.robot_id} />}
        {tab === 'detections' && <DetectionsTab robotId={robot.robot_id} audience="staff" />}
        {tab === 'telemetry' && <TelemetryTab robotId={robot.robot_id} />}
        {tab === 'missions' && (
          <div className="flex flex-col gap-6">
            <MissionStatsCard robot={robot} />
            <RobotMonthCharts robotId={robot.robot_id} />
            <RobotMissionsTab robotId={robot.robot_id} />
          </div>
        )}
        {tab === 'events' && <RobotEventsTab robotId={robot.robot_id} />}
        {tab === 'keys' && <IngestClientsPanel robotIds={[robot.robot_id]} scopeLabel={robot.robot_id} />}
        {tab === 'hardware' && <HardwareTab robotId={robot.robot_id} />}
        {tab === 'software' && <SoftwareTab robotId={robot.robot_id} />}
        {tab === 'connectivity' && <ConnectivityTab robotId={robot.robot_id} />}
        {tab === 'credentials' && <CredentialsTab robotId={robot.robot_id} />}
        {tab === 'documents' && <DocumentsTab robot={robot} />}
        {tab === 'dispatch' && <DispatchTab robotId={robot.robot_id} />}
        {tab === 'maintenance' && <MaintenanceTab robotId={robot.robot_id} />}
        {tab === 'ownership' && <OwnershipTab robotId={robot.robot_id} />}
        {tab === 'log' && <RobotLogTab robotId={robot.robot_id} />}
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
      description="The Robot ID, serial number and product are permanent and cannot be edited."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => m.mutate()} loading={m.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Serial number" hint="Generated by the PMS at registration (8 digits). Permanent.">
          <Input value={robot.serial_number} readOnly className="font-mono" />
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
