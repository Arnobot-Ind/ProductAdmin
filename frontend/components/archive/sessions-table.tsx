'use client';

import type { ArchiveRobotLinkDto, ArchiveSessionDto } from '@arnobot/message-schema';
import { AlertTriangle, Play } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Time } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { fmtBytes, fmtDuration, fmtRelative } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { SessionStatusBadge, UploadBadge } from './badges';

export const videoHref = (s: { id: string }) => `/videos/${s.id}`;

/** Recorded sessions; click a row to open the player. */
export function SessionsTable({ sessions, showRobot, caption, empty }: { sessions: ArchiveSessionDto[]; showRobot?: boolean; caption: string; empty?: string }) {
  const router = useRouter();
  return (
    <DataTable
      caption={caption}
      rows={sessions}
      rowKey={(s) => s.id}
      onRowClick={(s) => router.push(videoHref(s))}
      empty={empty ?? 'No recordings yet.'}
      columns={[
        ...(showRobot
          ? [
              {
                key: 'robot',
                header: 'Robot',
                rowHeader: true,
                cell: (s: ArchiveSessionDto) => (
                  <span className="flex flex-col">
                    <Link href={`/robots/${s.robot_id}?tab=videos`} onClick={(e) => e.stopPropagation()} className="font-mono font-semibold text-accent-text hover:underline">
                      {s.robot_id}
                    </Link>
                    <span className="text-xs text-muted">{s.product_name}</span>
                  </span>
                ),
              },
            ]
          : []),
        {
          key: 'session',
          header: 'Recording',
          rowHeader: !showRobot,
          cell: (s) => (
            <span className="flex flex-col gap-0.5">
              <Link href={videoHref(s)} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 font-mono text-xs font-medium text-accent-text hover:underline">
                <Play className="size-3.5" aria-hidden />
                {s.session_id}
              </Link>
              <span className="flex flex-wrap gap-1">
                {s.trip && <span className="text-xs text-muted">{s.trip}</span>}
                {s.simulated && (
                  <Badge tone="warn" className="px-1.5 py-0 text-[10px]">
                    Simulated
                  </Badge>
                )}
              </span>
            </span>
          ),
        },
        { key: 'start', header: 'Started', cell: (s) => <Time iso={s.started_at} /> },
        { key: 'dur', header: 'Duration', align: 'right', cell: (s) => fmtDuration(s.duration_s) },
        {
          key: 'cams',
          header: 'Cameras',
          cell: (s) => (s.cameras.length ? <span className="font-mono text-xs">{s.cameras.join(' · ')}</span> : <span className="text-muted">none</span>),
        },
        {
          key: 'sensors',
          header: 'Sensors',
          cell: (s) => <span className="text-xs">{[s.has_lidar && 'LiDAR', s.has_imu && 'IMU'].filter(Boolean).join(' · ') || <span className="text-muted">—</span>}</span>,
        },
        { key: 'size', header: 'Size', align: 'right', cell: (s) => fmtBytes(s.bytes.total) },
        {
          key: 'status',
          header: 'Status',
          cell: (s) => (
            <span className="flex flex-wrap gap-1">
              <SessionStatusBadge status={s.status} />
              <UploadBadge upload={s.upload} status={s.status} />
              {s.deleted_at && <Badge tone="fault">Deleted</Badge>}
            </span>
          ),
        },
        {
          key: 'open',
          header: <span className="sr-only">Open</span>,
          align: 'right',
          cell: (s) => (
            <Link
              href={videoHref(s)}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2"
              aria-label={`Open recording ${s.session_id}`}
            >
              <Play className="size-3.5" aria-hidden /> Open
            </Link>
          ),
        },
      ]}
    />
  );
}

/** The robot's own view of its upload health, from cloud_sync's heartbeat. */
export function RobotLinkPanel({ link }: { link: ArchiveRobotLinkDto | null }) {
  const now = useNow(5000);
  if (!link || (!link.last_seen_at && !link.last_upload_at)) {
    return <p className="text-sm text-muted">This robot has not uploaded any video yet. Once cloud_sync runs with its ingest key, recordings appear here.</p>;
  }
  const heartbeatAge = link.last_seen_at ? now - Date.parse(link.last_seen_at) : Infinity;
  const stale = heartbeatAge > 5 * 60_000;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {link.last_seen_at ? (
          <>
            Heartbeat {fmtRelative(link.last_seen_at, now)}
            {stale && <span className="text-muted">: the robot is off, offline or not sending. Its files wait on the robot until it is back.</span>}
          </>
        ) : (
          'No heartbeat received yet.'
        )}
        {link.last_upload_at && <span className="text-muted"> · last file {fmtRelative(link.last_upload_at, now)}</span>}
        {!stale && link.recording_session_id && (
          <>
            {' '}
            · recording <span className="font-mono">{link.recording_session_id}</span>
          </>
        )}
        {!stale && (link.pending_files > 0 ? ` · ${link.pending_files} file(s), ${fmtBytes(link.pending_bytes)} waiting to upload` : ' · nothing waiting to upload')}
      </p>
      {!stale &&
        link.alerts.map((a, i) => (
          <div key={`${a.code}-${i}`} role="alert" className={`flex items-start gap-2 rounded-md border px-3 py-2 ${a.severity === 'critical' ? 'border-fault/40 bg-fault-bg' : 'border-warn/40 bg-warn-bg'}`}>
            <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${a.severity === 'critical' ? 'text-fault' : 'text-warn'}`} aria-hidden />
            <span>
              {a.code && <span className="font-mono text-xs font-semibold">{a.code} </span>}
              {a.message}
            </span>
          </div>
        ))}
    </div>
  );
}
