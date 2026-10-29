'use client';

import type { HardwareRevisionDto, ProductDto, RobotDetailDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitBranch, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { missionHref } from '@/components/domain/missions-table';
import { RobotStatusBadge } from '@/components/domain/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, InlineAlert, LastSeen, QueryView } from '@/components/ui/misc';
import { CategoryBadge } from '@/components/domain/status';
import { ProductPicture } from '@/components/domain/product-media';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';
import { ConnectivityTab } from './_tabs/connectivity';
import { DetectionsTab } from '@/components/domain/detections';
import { ActivityCalendar, CalendarLayout, type ActivityMetric } from '@/components/domain/activity-calendar';
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
import { AttachmentsTab } from './_tabs/attachments';
import { RobotBuild } from '@/components/domain/robot-build';
import { NotesTab, PinnedNotes } from './_tabs/notes';
import { SoftwareTab } from './_tabs/software';
import { TelemetryTab } from './_tabs/telemetry';
import { VideosTab } from './_tabs/videos';
import { DataActivityBadge } from '@/components/archive/badges';
import { BesideBack } from '@/components/ui/back-button';
import { Band, BandFact } from '@/components/ui/band';
import { fmtDistance } from '@/lib/format';

/**
 * The robot record. The header says what the robot is (name, category, status, description, serial number, owner,
 * lifetime distance and missions, software version and repository, last seen, pictures). Below it, sections in the
 * order people use them: Live status, Logs, Software (with SSH access), then Recordings, Hardware and Records.
 * ?tab= keeps the view's id, so old links still work.
 */
/** Which count the activity calendar shades for each Recordings tab (and Logs), and back. */
const TAB_METRIC: Record<string, ActivityMetric> = { videos: 'recordings', detections: 'detections', missions: 'missions', events: 'events', log: 'log' };
const METRIC_TAB: Record<ActivityMetric, string> = { recordings: 'videos', detections: 'detections', missions: 'missions', events: 'events', log: 'log' };

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
    id: 'logs',
    label: 'Logs',
    tabs: [{ id: 'log', label: 'Activity log' }],
  },
  {
    id: 'software',
    label: 'Software',
    tabs: [
      { id: 'software', label: 'Installed software' },
      { id: 'ssh', label: 'SSH access', perm: 'credential.read_meta' },
      { id: 'credentials', label: 'Other credentials', perm: 'credential.read_meta' },
      { id: 'keys', label: 'Robot & GCS keys', perm: 'ingest.manage' },
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
      { id: 'attachments', label: 'Attachments' },
      { id: 'hardware', label: 'Parts fitted' },
      { id: 'maintenance', label: 'Maintenance' },
      { id: 'dispatch', label: 'Dispatch & warranty' },
    ],
  },
  {
    id: 'records',
    label: 'Records',
    tabs: [
      { id: 'notes', label: 'Journal' },
      { id: 'documents', label: 'Documents' },
      { id: 'ownership', label: 'Ownership' },
    ],
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
  /** The activity calendar's day (IST), shared by the Recordings tabs and kept in the URL. */
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day') : null;
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
      <header className="mb-6">
        <BesideBack
          above={
            <nav aria-label="Breadcrumb" className="text-sm text-muted">
              <Link href="/robots" className="hover:underline">
                Robots
              </Link>{' '}
              / <span aria-current="page">{robot.robot_id}</span>
            </nav>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold">
                <span className="font-mono">{robot.robot_id}</span>
                {robot.nickname && <span> · {robot.nickname}</span>}
              </h1>
              <CategoryBadge category={robot.category} />
              <RobotStatusBadge lastSeenAt={robot.last_seen_at} showAge />
              <DataActivityBadge lastSeenAt={robot.last_seen_at} lastUploadAt={robot.last_upload_at} sendingData={robot.sending_data} recording={robot.recording} />
              {robot.deleted_at && <Badge tone="fault">Deleted</Badge>}
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
          </div>
        </BesideBack>

        {/* What the robot is, on the brand band: picture, product and description, then the identity facts. */}
        <Band label={`${robot.robot_id} summary`} className="mt-4">
          <div className="grid gap-6 p-5 sm:p-6 md:grid-cols-[13rem_minmax(0,1fr)]">
            <ProductPicture productId={robot.product_id} name={`${robot.product_name} · ${robot.robot_id}`} />
            <div className="min-w-0">
              <p className="max-w-3xl text-base">
                {robot.description ?? <span className="text-muted">{robot.product_description ?? 'No description yet. Use Edit to add one.'}</span>}
              </p>
              <RobotBuild
                className="mt-3"
                category={robot.category}
                product={{ id: robot.product_id, name: robot.product_name, revision: robot.hardware_revision, coverPhotoId: robot.product_cover_photo_id }}
                attachments={robot.attachments}
                onFit={can('robot.write') && !robot.deleted_at ? () => openTab('attachments') : undefined}
              />
              {robot.current_mission_id && (
                <p className="mt-2 text-base">
                  <span className="text-muted">On mission </span>
                  <Link href={missionHref({ robot_id: robot.robot_id, mission_id: robot.current_mission_id })} className={cn('font-medium text-accent-text hover:underline', !robot.current_mission_name && 'font-mono')} title={robot.current_mission_id}>
                    {robot.current_mission_name ?? robot.current_mission_id}
                  </Link>
                </p>
              )}
              <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-2 xl:grid-cols-3">
                <BandFact label="Serial number">
                  <span className="font-mono">{robot.serial_number}</span>
                </BandFact>
                <BandFact label="Current owner">
                  <span title={robot.owner_company ?? undefined}>{robot.owner_company ?? '—'}</span>
                </BandFact>
                <div className="min-w-0">
                  <dt className="text-base text-muted">Last seen</dt>
                  <dd className="mt-1 text-lg">
                    <LastSeen iso={robot.last_seen_at} stacked />
                  </dd>
                </div>
                <BandFact label="Lifetime distance">{robot.odometer_m !== null ? fmtDistance(robot.odometer_m) : fmtDistance(robot.total_distance_m)}</BandFact>
                <BandFact label="Lifetime missions">
                  {robot.total_missions.toLocaleString('en-IN')} <span className="text-base font-normal text-muted">· {robot.completed.toLocaleString('en-IN')} completed</span>
                </BandFact>
                <div className="min-w-0">
                  <dt className="text-base text-muted">Software</dt>
                  <dd className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-lg font-semibold">
                    <span className="font-mono">{robot.sw_ver ?? 'Not reported'}</span>
                    {robot.repo_url ? (
                      <a href={robot.repo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-base font-medium text-accent-text hover:underline">
                        <GitBranch className="size-4" aria-hidden /> Repository <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    ) : (
                      <span className="text-sm font-normal text-muted">No repository link</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </Band>
        <PinnedNotes robotId={robot.robot_id} onOpen={() => openTab('notes')} />
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
        {(section.id === 'recordings' || tab === 'log') && (
          <CalendarLayout
            calendar={
              <ActivityCalendar
                robotId={robot.robot_id}
                metric={TAB_METRIC[tab] ?? 'recordings'}
                day={day}
                onDay={(d) => setParams({ day: d })}
                onOpen={(m) => openTab(METRIC_TAB[m])}
              />
            }
          >
            {tab === 'videos' && <VideosTab robotId={robot.robot_id} day={day} />}
            {tab === 'detections' && <DetectionsTab robotId={robot.robot_id} audience="staff" day={day} />}
            {tab === 'missions' &&
              (day ? (
                <RobotMissionsTab robotId={robot.robot_id} day={day} />
              ) : (
                <div className="flex flex-col gap-6">
                  <MissionStatsCard robot={robot} />
                  <RobotMonthCharts robotId={robot.robot_id} />
                  <RobotMissionsTab robotId={robot.robot_id} />
                </div>
              ))}
            {tab === 'events' && <RobotEventsTab robotId={robot.robot_id} day={day} />}
            {tab === 'log' && <RobotLogTab robotId={robot.robot_id} day={day} onClearDay={() => setParams({ day: null })} />}
          </CalendarLayout>
        )}
        {tab === 'telemetry' && <TelemetryTab robotId={robot.robot_id} />}
        {tab === 'keys' && <IngestClientsPanel robotIds={[robot.robot_id]} scopeLabel={robot.robot_id} />}
        {tab === 'attachments' && <AttachmentsTab robotId={robot.robot_id} category={robot.category} />}
        {tab === 'hardware' && <HardwareTab robotId={robot.robot_id} />}
        {tab === 'software' && <SoftwareTab robotId={robot.robot_id} />}
        {tab === 'connectivity' && <ConnectivityTab robotId={robot.robot_id} />}
        {tab === 'ssh' && <CredentialsTab robotId={robot.robot_id} only="ssh" />}
        {tab === 'credentials' && <CredentialsTab robotId={robot.robot_id} only="other" />}
        {tab === 'notes' && <NotesTab robotId={robot.robot_id} />}
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
  const [revisionId, setRevisionId] = useState(robot.hardware_revision_id ?? '');
  const [notes, setNotes] = useState(robot.notes ?? '');
  const [nickname, setNickname] = useState(robot.nickname ?? '');
  const [description, setDescription] = useState(robot.description ?? '');
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
        nickname: nickname.trim() || null,
        description: description.trim() || null,
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
      description="The Robot ID, serial number and base model are permanent and cannot be edited."
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
        <Field label="Nickname" hint="A short name people use for it, shown next to the Robot ID everywhere, e.g. Khavda patrol 1.">
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={60} data-autofocus />
        </Field>
        <Field label="Short description" hint="One or two lines: what it does and where. Shown on lists and when hovering the robot.">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
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
