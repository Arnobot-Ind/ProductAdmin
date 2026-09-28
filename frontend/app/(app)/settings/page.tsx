'use client';

import type { SystemStatusDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Cloud, Database, Film, HardDrive, Monitor, Radio, RefreshCw, Server, Wifi, XCircle, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Card, InlineAlert, KeyValue, Mono, PageHeader } from '@/components/ui/misc';
import { api, ApiError } from '@/lib/api';
import { fmtBytes, fmtDuration, fmtRelative } from '@/lib/format';
import { useDocumentTitle, useNow } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';

const POLL_MS = 5_000;

export default function SettingsPage() {
  useDocumentTitle('Settings & status');
  const now = useNow(1000);
  const { connected } = useRealtime();
  const q = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatusDto>('/system/status'),
    refetchInterval: POLL_MS,
    retry: false,
  });
  const s = q.data;
  // The panel reaches the backend through its own proxy: a failed request means the backend server is down.
  const serverDown = q.isError && (!(q.error instanceof ApiError) || q.error.status === 0 || q.error.status >= 500);
  const stale = q.isError && s !== undefined;

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Settings & status"
        description={`Live health of the PMS services: the backend server, the database, video storage and the robot fleet link. Checked every ${POLL_MS / 1000} s.`}
        actions={
          <Button icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void q.refetch()} loading={q.isFetching}>
            Check now
          </Button>
        }
      />

      {serverDown && (
        <div className="mb-4">
          <InlineAlert tone="fault" title="The backend server is not responding">
            The admin panel cannot reach the PMS backend (port 4000). Start it with <Mono>npm run dev</Mono> in <Mono>backend/</Mono>.{' '}
            {stale && 'The values below are from the last successful check.'}
          </InlineAlert>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ServiceTile Icon={Server} label="Backend server" ok={!serverDown && !!s} pending={q.isLoading} okText="Running" badText="Not responding" detail={s && !serverDown ? `up ${fmtDuration(s.server.uptime_s)}` : undefined} />
        <ServiceTile Icon={Database} label="Database" ok={!!s?.database.ok && !serverDown} pending={q.isLoading} okText="Connected" badText={serverDown ? 'Unknown' : 'Not connected'} detail={s?.database.ok ? `${s.database.latency_ms ?? '—'} ms round trip` : (s?.database.error ?? undefined)} />
        <ServiceTile Icon={Cloud} label="Video storage (S3)" ok={!!s?.storage.archive.ok && !serverDown} pending={q.isLoading} okText="Reachable" badText={serverDown ? 'Unknown' : 'Not reachable'} detail={s?.storage.archive.ok ? s.storage.archive.location : (s?.storage.archive.detail ?? undefined)} />
        <ServiceTile
          Icon={Radio}
          label="Robots sending data"
          ok={!!s && s.robots.sending_data > 0}
          neutral={!!s && s.robots.sending_data === 0}
          pending={q.isLoading}
          okText={`${s?.robots.sending_data ?? 0} sending now`}
          badText="None sending"
          detail={s ? `${s.robots.online} online · ${s.robots.recording} recording · ${s.robots.offline} offline` : undefined}
        />
      </div>

      {s && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={<Title Icon={Server}>Backend server</Title>} actions={<StatusBadge ok={!serverDown} okText="Running" badText="Down" />}>
            <KeyValue
              items={[
                { label: 'Role', value: 'Ingest (robots) + admin API; stateless: keeps no data' },
                { label: 'Port', value: <Mono>{s.server.port}</Mono> },
                { label: 'Started', value: fmtRelative(s.server.started_at, now) },
                { label: 'Version', value: `${s.server.version} · Node ${s.server.node}` },
                { label: 'Environment', value: s.server.environment },
                { label: 'Last check', value: fmtRelative(s.checked_at, now) },
              ]}
            />
          </Card>

          <Card title={<Title Icon={Database}>Database (PostgreSQL)</Title>} actions={<StatusBadge ok={s.database.ok} okText="Connected" badText="Not connected" />}>
            {s.database.error && (
              <div className="mb-3">
                <InlineAlert tone="fault">{s.database.error}</InlineAlert>
              </div>
            )}
            <KeyValue
              items={[
                { label: 'Role', value: 'Separate service: all records survive a server restart or crash' },
                { label: 'Database', value: s.database.name ? <Mono>{s.database.name}</Mono> : '—' },
                { label: 'Version', value: s.database.version ? `PostgreSQL ${s.database.version}` : '—' },
                { label: 'Size', value: fmtBytes(s.database.size_bytes) },
                { label: 'Round trip', value: s.database.latency_ms !== null ? `${s.database.latency_ms} ms` : '—' },
                {
                  label: 'Migrations',
                  value: (
                    <span>
                      {s.database.migrations.applied} applied
                      {s.database.migrations.pending > 0 && <Badge tone="warn" className="ml-2">{s.database.migrations.pending} pending: run npm run db:migrate</Badge>}
                    </span>
                  ),
                },
              ]}
            />
          </Card>

          <Card title={<Title Icon={Cloud}>Video storage</Title>} actions={<StatusBadge ok={s.storage.archive.ok} okText="Reachable" badText="Not reachable" />}>
            {!s.storage.archive.ok && s.storage.archive.detail && (
              <div className="mb-3">
                <InlineAlert tone="fault">{s.storage.archive.detail}</InlineAlert>
              </div>
            )}
            <KeyValue
              items={[
                { label: 'Role', value: 'Camera video + sensor data, stored only in the bucket (never on the server)' },
                { label: 'Bucket', value: <Mono>{s.storage.archive.location}</Mono> },
                { label: 'Recordings', value: s.archive.sessions.toLocaleString() },
                { label: 'Files', value: s.archive.files.toLocaleString() },
                { label: 'Stored', value: fmtBytes(s.archive.bytes) },
                { label: 'Last file received', value: s.archive.last_upload_at ? fmtRelative(s.archive.last_upload_at, now) : 'never' },
              ]}
            />
          </Card>

          <Card title={<Title Icon={HardDrive}>Documents & other services</Title>}>
            <ul className="flex flex-col divide-y divide-border text-sm">
              <ServiceLine Icon={HardDrive} label="Document storage" ok={s.storage.documents.ok} detail={`${s.storage.documents.driver}${s.storage.documents.detail ? `: ${s.storage.documents.detail}` : ''}`} />
              <ServiceLine Icon={Film} label="ffmpeg (MP4 download)" ok={s.ffmpeg.available} detail={s.ffmpeg.available ? `version ${s.ffmpeg.version}` : 'not installed: MP4 download is off'} />
              <ServiceLine Icon={Wifi} label="Live updates to this browser" ok={connected} detail={connected ? 'pushed as they happen' : 'socket down: pages refresh every 15 s'} />
              <ServiceLine
                Icon={Radio}
                label="MQTT ingest"
                ok={s.mqtt.configured ? s.mqtt.connected === true : null}
                detail={s.mqtt.configured ? (s.mqtt.connected ? 'connected to the broker' : 'not connected to the broker') : 'not configured (HTTPS ingest only)'}
              />
              <ServiceLine Icon={Monitor} label="Admin panel" ok detail="separate app: talks to the backend only through its API" />
            </ul>
          </Card>

          <Card title={<Title Icon={Radio}>Fleet link</Title>} className="lg:col-span-2" actions={<Link href="/robots" className="text-sm text-accent-text hover:underline">All robots →</Link>}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Count label="Robots" value={s.robots.total} />
              <Count label="Online" value={s.robots.online} tone="ok" />
              <Count label="Sending data" value={s.robots.sending_data} tone="ok" />
              <Count label="Recording" value={s.robots.recording} tone="accent" />
              <Count label="Stale" value={s.robots.stale} tone="warn" />
              <Count label="Offline" value={s.robots.offline} />
            </dl>
            <p className="mt-3 text-xs text-muted">
              Online = a message or file in the last 60 s. Sending data = a video or sensor file stored in the last 2 minutes. Recording = the robot&apos;s heartbeat names an open session.
            </p>
          </Card>
        </div>
      )}
    </>
  );
}

function Title({ Icon, children }: { Icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon className="size-4 text-muted" aria-hidden />
      {children}
    </span>
  );
}

function StatusBadge({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return ok ? (
    <Badge tone="ok" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
      {okText}
    </Badge>
  ) : (
    <Badge tone="fault" icon={<XCircle className="size-3.5" aria-hidden />}>
      {badText}
    </Badge>
  );
}

function ServiceTile({
  Icon,
  label,
  ok,
  neutral,
  pending,
  okText,
  badText,
  detail,
}: {
  Icon: LucideIcon;
  label: string;
  ok: boolean;
  neutral?: boolean;
  pending?: boolean;
  okText: string;
  badText: string;
  detail?: string;
}) {
  const tone = pending ? 'text-muted' : ok ? 'text-ok' : neutral ? 'text-muted' : 'text-fault';
  const dot = pending ? 'bg-offline' : ok ? 'bg-ok' : neutral ? 'bg-offline' : 'bg-fault';
  return (
    <section className="rounded-lg border border-border bg-surface p-4" aria-label={label}>
      <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
        <Icon className="size-4" aria-hidden />
        {label}
      </p>
      <p className={`mt-2 flex items-center gap-2 font-display text-lg font-bold ${tone}`} aria-live="polite">
        <span className={`size-2.5 rounded-full ${dot} ${ok && !pending ? 'animate-pulse' : ''}`} aria-hidden />
        {pending ? 'Checking…' : ok ? okText : badText}
      </p>
      {detail && <p className="mt-1 truncate text-xs text-muted" title={detail}>{detail}</p>}
    </section>
  );
}

function ServiceLine({ Icon, label, ok, detail }: { Icon: LucideIcon; label: string; ok: boolean | null; detail: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Icon className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
      {ok === null ? <Badge tone="neutral">Off</Badge> : ok ? <Badge tone="ok">OK</Badge> : <Badge tone="fault">Down</Badge>}
    </li>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'accent' }) {
  const color = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent-text' : '';
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`font-display text-xl font-bold ${value ? color : ''}`}>{value}</dd>
    </div>
  );
}
