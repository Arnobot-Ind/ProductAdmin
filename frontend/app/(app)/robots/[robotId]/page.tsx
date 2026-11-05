'use client';

import { fmtSerial } from '@/lib/format';
import type { HardwareRevisionDto, ProductDto, RobotDetailDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitBranch, ImagePlus, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { RobotStatusBadge } from '@/components/domain/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, InlineAlert, QueryView } from '@/components/ui/misc';
import { ProductMediaCard, ProductPicture } from '@/components/domain/product-media';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useDocumentTitle, useUrlState } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';
import { DetectionsTab } from '@/components/domain/detections';
import { ActivityCalendar, CalendarLayout, type ActivityMetric } from '@/components/domain/activity-calendar';
import { IngestClientsPanel } from '@/components/domain/ingest-clients';
import { CredentialsTab } from './_tabs/credentials';
import { DispatchTab } from './_tabs/dispatch';
import { HardwareTab } from './_tabs/hardware';
import { MaintenanceTab } from './_tabs/maintenance';
import { RobotEventsTab, RobotMissionsTab } from './_tabs/lists';
import { MissionStatsCard, RobotMonthCharts } from './_tabs/overview';
import { RobotLogTab } from './_tabs/log';
import { AttachmentsTab } from './_tabs/attachments';
import { SoftwareTab } from './_tabs/software';
import { TelemetryTab } from './_tabs/telemetry';
import { VideosTab } from './_tabs/videos';
import { BesideBack } from '@/components/ui/back-button';
import { Band } from '@/components/ui/band';
import { fmtDistance, fmtWhen } from '@/lib/format';

/**
 * The robot record. The header says what the robot is (name, category, status, description, serial number, owner,
 * lifetime distance and missions, software version and repository, last seen, pictures). Below it, sections in the
 * order people use them: Sensor history, Logs, Recordings, Software (with SSH access), then Hardware.
 * ?tab= keeps the view's id, so old links still work.
 */
/** Which count the activity calendar shades for each Recordings tab (and Logs), and back. */
const TAB_METRIC: Record<string, ActivityMetric> = { videos: 'recordings', detections: 'detections', missions: 'missions', events: 'events', log: 'log' };
const METRIC_TAB: Record<ActivityMetric, string> = { recordings: 'videos', detections: 'detections', missions: 'missions', events: 'events', log: 'log' };

const SECTIONS: { id: string; label: string; tabs: { id: string; label: string; perm?: string }[] }[] = [
  {
    id: 'history',
    label: 'Sensor history',
    tabs: [
      { id: 'telemetry', label: 'Graphs' },
      { id: 'track', label: 'Map' },
    ],
  },
  { id: 'logs', label: 'Logs', tabs: [{ id: 'log', label: 'Machine logs' }] },
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
    id: 'hardware',
    label: 'Hardware',
    tabs: [
      { id: 'attachments', label: 'Attachments' },
      { id: 'hardware', label: 'Parts fitted' },
      { id: 'maintenance', label: 'Maintenance' },
      { id: 'dispatch', label: 'Dispatch & warranty' },
    ],
  },
];

/** "3 Nov 2026 - 4:55 pm", in IST. */
function fmtLastSeen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  return `${date} - ${time}`;
}

function BigFact({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold break-words">{children}</dd>
      {sub && <dd className="text-base text-muted">{sub}</dd>}
    </div>
  );
}

export default function RobotDetailPage() {
  const { robotId } = useParams<{ robotId: string }>();
  useDocumentTitle(fmtSerial(robotId));
  const router = useRouter();
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['robot', robotId, 'detail'],
    queryFn: () => api.get<RobotDetailDto>(`/robots/${robotId}`),
    refetchInterval: poll,
  });
  // An old address (/robots/saibya02, an old 8-digit serial, or a serial with dashes) opens the robot; the address
  // bar then switches to its serial number, keeping the tab.
  const serial = q.data?.robot_id;
  useEffect(() => {
    if (serial && serial !== robotId) router.replace(`/robots/${serial}${window.location.search}`);
  }, [serial, robotId, router]);
  return <QueryView query={q} rows={8}>{(r) => <RobotDetail robot={r} />}</QueryView>;
}

function RobotDetail({ robot }: { robot: RobotDetailDto }) {
  const can = useCan();
  const [params, setParams] = useUrlState();
  const sections = SECTIONS.map((sec) => ({ ...sec, tabs: sec.tabs.filter((t) => !t.perm || can(t.perm)) })).filter((sec) => sec.tabs.length);
  const requested = params.get('tab') ?? 'telemetry';
  const tab = sections.some((sec) => sec.tabs.some((t) => t.id === requested)) ? requested : 'telemetry';
  const section = sections.find((sec) => sec.tabs.some((t) => t.id === tab))!;
  const openTab = (id: string) => setParams({ tab: id === 'telemetry' ? null : id });
  /** The activity calendar's day (IST), shared by the Recordings tabs and kept in the URL. */
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') ?? '') ? params.get('day') : null;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Whose pictures the photo manager shows: the base model's or one attachment's. */
  const [media, setMedia] = useState<{ owner: 'products' | 'attachments'; id: string; name: string } | null>(null);
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
              / <span aria-current="page">{fmtSerial(robot.robot_id)}</span>
            </nav>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold">
                {robot.nickname ?? robot.product_name}
              </h1>
              <RobotStatusBadge lastSeenAt={robot.last_seen_at} />
              <span className="text-base font-bold text-fg">Last seen - {fmtLastSeen(robot.last_seen_at)}</span>
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

        {/* What the robot is: its picture filling the left side (click for large), the facts as plain large text beside it. */}
        <Band label={`${fmtSerial(robot.robot_id)} summary`} className="mt-3">
          <div className="grid md:grid-cols-[20rem_minmax(0,1fr)]">
            <div className="relative min-h-60 border-b border-border md:border-r md:border-b-0">
              <ProductPicture productId={robot.product_id} name={robot.nickname ?? robot.product_name} className="absolute inset-0" />
              {can('catalog.write') && (
                <button type="button" onClick={() => setMedia({ owner: 'products', id: robot.product_id, name: robot.product_name })} title="Add or change photos" aria-label="Add or change photos" className="absolute top-2 right-2 inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface/90 text-muted hover:text-fg">
                  <ImagePlus className="size-4" aria-hidden />
                </button>
              )}
            </div>
            <div className="min-w-0 p-5">
              {robot.description && <p className="mb-4 max-w-3xl text-lg">{robot.description}</p>}
              <dl className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
                <BigFact label="Base model" sub={[robot.category.toUpperCase(), `No. ${String(robot.model_no).padStart(3, '0')}`, robot.hardware_revision].filter(Boolean).join(' · ')}>
                  {robot.product_name}
                </BigFact>
                <BigFact label="Attachment">{robot.attachments.length ? robot.attachments.map((a) => a.name).join(', ') : <span className="font-normal text-muted">None</span>}</BigFact>
                <BigFact label="Current owner">{robot.owner_company ?? '—'}</BigFact>
                <BigFact label="Deployed at" sub={robot.site ? [robot.site.city, `since ${fmtWhen(robot.site.deployed_since)}`].filter(Boolean).join(' · ') : undefined}>
                  {robot.site ? (
                    robot.site.name
                  ) : (
                    <span className="font-normal text-muted">Not deployed</span>
                  )}
                </BigFact>
                <BigFact label="Lifetime distance">{robot.odometer_m !== null ? fmtDistance(robot.odometer_m) : fmtDistance(robot.total_distance_m)}</BigFact>
                <BigFact label="Software">
                  {robot.sw_ver ?? <span className="font-normal text-muted">Not reported</span>}
                  {robot.repo_url && (
                    <a href={robot.repo_url} target="_blank" rel="noopener noreferrer" className="ml-3 inline-flex items-center gap-1 text-base font-medium text-accent-text hover:underline">
                      <GitBranch className="size-4" aria-hidden /> Repository <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  )}
                </BigFact>
              </dl>
            </div>
          </div>
        </Band>
      </header>

      {robot.deleted_at && (
        <div className="mb-4">
          <InlineAlert tone="fault">This robot is deleted. Its data is kept, and its serial number is never reused. Restore it to accept messages again.</InlineAlert>
        </div>
      )}

      <Tabs
        label="Robot record sections"
        items={sections.map((sec) => ({ id: sec.id, label: sec.label }))} value={section.id} onChange={(id) => openTab(sections.find((sec) => sec.id === id)!.tabs[0].id)} />
      {section.tabs.length > 1 && (
        <div role="group" aria-label={`${section.label} views`} className="mt-2 flex flex-wrap gap-1.5">
          {section.tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === tab}
              onClick={() => openTab(t.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                t.id === tab ? 'border-accent bg-accent-soft text-accent-text' : 'border-border bg-surface text-muted hover:border-accent/50 hover:text-fg',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <TabPanel id={section.id} className="pt-3">
        {section.id === 'recordings' && (
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
          </CalendarLayout>
        )}
        {tab === 'log' && <RobotLogTab robotId={robot.robot_id} day={day} />}
        {/* One element for both views, so the chosen time range stays when moving between them. */}
        {section.id === 'history' && <TelemetryTab robotId={robot.robot_id} view={tab === 'track' ? 'map' : 'graphs'} />}
        {tab === 'keys' && <IngestClientsPanel robotIds={[robot.robot_id]} scopeLabel={robot.robot_id} />}
        {tab === 'attachments' && <AttachmentsTab robotId={robot.robot_id} category={robot.category} />}
        {tab === 'hardware' && <HardwareTab robotId={robot.robot_id} />}
        {tab === 'software' && <SoftwareTab robot={robot} />}
        {tab === 'ssh' && <CredentialsTab robotId={robot.robot_id} only="ssh" />}
        {tab === 'credentials' && <CredentialsTab robotId={robot.robot_id} only="other" />}
        {tab === 'dispatch' && <DispatchTab robotId={robot.robot_id} />}
        {tab === 'maintenance' && <MaintenanceTab robotId={robot.robot_id} />}
      </TabPanel>

      <EditRobotDialog robot={robot} open={editing} onClose={() => setEditing(false)} />
      <Dialog
        open={!!media}
        onClose={() => setMedia(null)}
        size="xl"
        title={media ? `Photos of ${media.name}` : ''}
        description={
          media?.owner === 'attachments'
            ? `The pictures belong to the attachment ${media.name}, so every robot with it fitted shows them. The main photo is its picture on robot pages and in the attachments list.`
            : `The pictures belong to the base model ${robot.product_name}, so every ${robot.product_name} robot shows them. The main photo is the picture shown on this page and in lists.`
        }
      >
        {media && <ProductMediaCard owner={media.owner} productId={media.id} name={media.name} />}
      </Dialog>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => del.mutate()}
        loading={del.isPending}
        danger
        title={`Delete ${fmtSerial(robot.robot_id)}?`}
        description="The robot is marked deleted (soft delete). All history is kept, the serial number is never reused, and it can be restored. Messages from a deleted robot are rejected."
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
      title={`Edit ${fmtSerial(robot.robot_id)}`}
      description="The serial number and base model are permanent and cannot be edited."
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
        <Field label="Nickname" hint="A short name people use for it, shown next to the serial number everywhere, e.g. Khavda patrol 1.">
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={60} data-autofocus />
        </Field>
        <Field label="Short description" hint="One or two lines: what it does and where. Shown on lists and when hovering the robot.">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <Field label="Serial number" hint="Given by the PMS at registration (category · base model · main attachment · running number · 2 random digits). Permanent.">
          <Input value={fmtSerial(robot.serial_number)} readOnly className="font-mono" />
        </Field>
        <Field
          label="Hardware revision"
          hint={`Which revision of ${robot.product_name} this robot is.`}
        >
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
