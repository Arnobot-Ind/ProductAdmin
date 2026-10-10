'use client';

import type { DeviceHealthDto, EventSeverity, HealthLevel, MissionState, RobotStatus } from '@arnobot/message-schema';
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, CircleDot, CircleOff, Info, Loader, WifiOff, XCircle } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/misc';
import { fmtRelative, fmtUtc } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { computeRobotStatus } from '@/lib/schema';

const STATUS: Record<RobotStatus, { tone: Tone; label: string; Icon: typeof CircleDot }> = {
  online: { tone: 'ok', label: 'Online', Icon: CircleDot },
  stale: { tone: 'warn', label: 'Stale', Icon: AlertTriangle },
  offline: { tone: 'offline', label: 'Offline', Icon: WifiOff },
};

/**
 * Spec §7: status is COMPUTED from last-seen time. Recomputed every 5 s in the browser so a robot
 * that stops reporting turns Stale → Offline on screen even when no new data arrives.
 */
export function RobotStatusBadge({ lastSeenAt, showAge }: { lastSeenAt: string | null; showAge?: boolean }) {
  const now = useNow(5000);
  const status = computeRobotStatus(lastSeenAt, new Date(now));
  const s = STATUS[status];
  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={s.tone} icon={<s.Icon className="size-3.5" aria-hidden />} title={lastSeenAt ? `Last seen ${fmtUtc(lastSeenAt)}` : 'Never seen'}>
        {s.label}
      </Badge>
      {showAge && <span className="text-xs text-muted">{lastSeenAt ? fmtRelative(lastSeenAt, now) : 'never seen'}</span>}
    </span>
  );
}

export function useRobotStatus(lastSeenAt: string | null): RobotStatus {
  const now = useNow(5000);
  return computeRobotStatus(lastSeenAt, new Date(now));
}

const HEALTH: Record<HealthLevel, { tone: Tone; label: string; Icon: typeof CheckCircle2 }> = {
  ok: { tone: 'ok', label: 'OK', Icon: CheckCircle2 },
  warning: { tone: 'warn', label: 'Warning', Icon: AlertTriangle },
  fault: { tone: 'fault', label: 'Fault', Icon: XCircle },
};

export function HealthBadge({ level, device }: { level: HealthLevel | null; device?: string }) {
  if (!level) {
    return (
      <Badge tone="neutral" icon={<CircleDashed className="size-3.5" aria-hidden />} title="Not reported">
        {device ? `${device}: ` : ''}Unknown
      </Badge>
    );
  }
  const h = HEALTH[level];
  return (
    <Badge tone={h.tone} icon={<h.Icon className="size-3.5" aria-hidden />}>
      {device ? `${device}: ` : ''}
      {h.label}
    </Badge>
  );
}

const DEVICE_LABELS: Record<keyof DeviceHealthDto, string> = { controller: 'Controller', lidar: 'LiDAR', cameras: 'Cameras', gps: 'GPS' };

/** Spec §7: OK / Warning / Fault per device (Controller / LiDAR / Cameras / GPS). */
export function HealthChips({ health, compact }: { health: DeviceHealthDto; compact?: boolean }) {
  const devices = Object.keys(DEVICE_LABELS) as (keyof DeviceHealthDto)[];
  if (compact) {
    const bad = devices.filter((d) => health[d] === 'fault' || health[d] === 'warning');
    if (!bad.length) {
      const allUnknown = devices.every((d) => !health[d]);
      return allUnknown ? <span className="text-xs text-muted">Not reported</span> : <HealthBadge level="ok" device="All" />;
    }
    return (
      <span className="flex flex-wrap gap-1">
        {bad.map((d) => (
          <HealthBadge key={d} level={health[d]} device={DEVICE_LABELS[d]} />
        ))}
      </span>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Device health">
      {devices.map((d) => (
        <li key={d}>
          <HealthBadge level={health[d]} device={DEVICE_LABELS[d]} />
        </li>
      ))}
    </ul>
  );
}

const SEVERITY: Record<EventSeverity, { tone: Tone; label: string; Icon: typeof Info }> = {
  info: { tone: 'accent', label: 'Info', Icon: Info },
  warning: { tone: 'warn', label: 'Warning', Icon: AlertTriangle },
  critical: { tone: 'fault', label: 'Critical', Icon: AlertOctagon },
};

export function SeverityBadge({ severity }: { severity: EventSeverity }) {
  const s = SEVERITY[severity];
  return (
    <Badge tone={s.tone} icon={<s.Icon className="size-3.5" aria-hidden />}>
      {s.label}
    </Badge>
  );
}

const EVENT_TYPE_LABEL: Record<string, string> = { abort: 'Abort', rth: 'RTH', alert: 'Alert', fault: 'Fault', update: 'Update' };
export function eventTypeLabel(t: string): string {
  return EVENT_TYPE_LABEL[t] ?? t;
}

const RESULT: Record<MissionState, { tone: Tone; label: string; Icon: typeof CheckCircle2 }> = {
  completed: { tone: 'ok', label: 'Completed', Icon: CheckCircle2 },
  failed: { tone: 'fault', label: 'Failed', Icon: XCircle },
  aborted: { tone: 'warn', label: 'Aborted', Icon: CircleOff },
  in_progress: { tone: 'accent', label: 'In progress', Icon: Loader },
};

export function MissionResultBadge({ result }: { result: MissionState }) {
  const r = RESULT[result] ?? RESULT.in_progress;
  return (
    <Badge tone={r.tone} icon={<r.Icon className="size-3.5" aria-hidden />}>
      {r.label}
    </Badge>
  );
}

export function WarrantyBadge({ status }: { status: 'none' | 'active' | 'expiring' | 'expired' }) {
  const map = {
    none: { tone: 'neutral' as Tone, label: 'No warranty recorded' },
    active: { tone: 'ok' as Tone, label: 'Warranty active' },
    expiring: { tone: 'warn' as Tone, label: 'Warranty expiring soon' },
    expired: { tone: 'fault' as Tone, label: 'Warranty expired' },
  }[status];
  return <Badge tone={map.tone}>{map.label}</Badge>;
}
