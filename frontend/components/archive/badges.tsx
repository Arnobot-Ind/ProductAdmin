'use client';

import type { ArchiveSessionStatus, ArchiveUploadState } from '@arnobot/message-schema';
import { CheckCircle2, CircleDot, CloudUpload, HelpCircle, PauseCircle, Radio, Upload } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/misc';
import { fmtRelative } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useRobotStatus } from '@/components/domain/status';

const STATUS: Record<ArchiveSessionStatus, { tone: Tone; label: string; Icon: typeof CircleDot; title: string }> = {
  active: { tone: 'ok', label: 'Recording', Icon: Radio, title: 'The robot is recording this session now' },
  closed: { tone: 'neutral', label: 'Closed', Icon: CheckCircle2, title: 'The operator stopped the session' },
  interrupted: { tone: 'warn', label: 'Interrupted', Icon: PauseCircle, title: 'Never stopped and nothing uploaded for a while: power or network was lost' },
};

export function SessionStatusBadge({ status }: { status: ArchiveSessionStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} icon={<s.Icon className="size-3.5" aria-hidden />} title={s.title}>
      {s.label}
    </Badge>
  );
}

const UPLOAD: Record<ArchiveUploadState, { tone: Tone; label: string; Icon: typeof CircleDot; title: string }> = {
  complete: { tone: 'ok', label: 'All uploaded', Icon: CloudUpload, title: 'Every file of the session is stored' },
  uploading: { tone: 'accent', label: 'Uploading', Icon: Upload, title: 'The robot is still uploading (or is offline with files waiting)' },
  unknown: { tone: 'neutral', label: 'Upload state unknown', Icon: HelpCircle, title: 'Recorded by an older cloud_sync that does not report completion' },
};

export function UploadBadge({ upload, status }: { upload: ArchiveUploadState; status: ArchiveSessionStatus }) {
  if (status === 'active' && upload !== 'complete') return null;
  const u = UPLOAD[upload];
  return (
    <Badge tone={u.tone} icon={<u.Icon className="size-3.5" aria-hidden />} title={u.title}>
      {u.label}
    </Badge>
  );
}

/**
 * Link state of a robot, as the fleet sees it: "Online · sending data" while files arrive (last 2 min),
 * "Recording" when its heartbeat names a session, otherwise the computed online/stale/offline state.
 */
export function DataActivityBadge({
  lastSeenAt,
  lastUploadAt,
  sendingData,
  recording,
  showAge,
}: {
  lastSeenAt: string | null;
  lastUploadAt: string | null;
  sendingData: boolean;
  recording: boolean;
  showAge?: boolean;
}) {
  const now = useNow(5000);
  const status = useRobotStatus(lastSeenAt);
  // Recompute in the browser so the badge ages out without new data.
  const sending = sendingData && lastUploadAt !== null && now - Date.parse(lastUploadAt) < 120_000;
  if (status !== 'offline' && sending) {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge tone="ok" icon={<span className="size-2 animate-pulse rounded-full bg-ok" aria-hidden />} title={`Last file received ${fmtRelative(lastUploadAt, now)}`}>
          Online · sending data
        </Badge>
        {showAge && <span className="text-xs text-muted">last file {fmtRelative(lastUploadAt, now)}</span>}
      </span>
    );
  }
  if (status !== 'offline' && recording) {
    return (
      <Badge tone="accent" icon={<Radio className="size-3.5" aria-hidden />} title="The robot's heartbeat says it is recording">
        Online · recording
      </Badge>
    );
  }
  if (!lastUploadAt) return <span className="text-xs text-muted">No data yet</span>;
  return (
    <span className="text-xs text-muted" title={lastUploadAt}>
      Last data {fmtRelative(lastUploadAt, now)}
    </span>
  );
}
