'use client';

import type { DeviceHealthDto, HealthLevel, LiveStateDto, RobotDetailDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  Camera,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Cpu,
  Gauge,
  MapPin,
  Navigation,
  Radar,
  Satellite,
  ShieldCheck,
  ShieldOff,
  Thermometer,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import { GeoMap } from '@/components/domain/geo-map';
import { Badge, Card, QueryView, Time } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtCoord, fmtDistance, fmtDuration, fmtNum, fmtRelative, humanize } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

type Tone = 'ok' | 'warn' | 'fault' | 'muted';
const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', fault: 'text-fault', muted: 'text-muted' };
const TONE_BG: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', fault: 'bg-fault', muted: 'bg-offline' };

const tabHref = (robotId: string, tab: string) => `/robots/${robotId}?tab=${tab}`;

export function OverviewTab({ robot }: { robot: RobotDetailDto }) {
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['robot', robot.robot_id, 'live'],
    queryFn: () => api.get<LiveStateDto>(`/robots/${robot.robot_id}/live`),
    refetchInterval: poll,
  });
  return <QueryView query={q} rows={6}>{(live) => <LiveView live={live} robot={robot} />}</QueryView>;
}

function LiveView({ live, robot }: { live: LiveStateDto; robot: RobotDetailDto }) {
  const now = useNow(1000);
  const points = useMemo(
    () => (live.position ? [{ id: 'robot', lon: live.position.lon, lat: live.position.lat, color: 'var(--map-actual)', label: robot.robot_id }] : []),
    [live.position, robot.robot_id],
  );
  const fresh = live.status === 'online';
  const id = robot.robot_id;

  return (
    <div className="flex flex-col gap-5">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted" aria-live="polite">
        <span className="relative flex size-2.5" aria-hidden>
          {fresh && <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60" />}
          <span className={cn('relative inline-flex size-2.5 rounded-full', fresh ? 'bg-ok' : live.status === 'stale' ? 'bg-warn' : 'bg-offline')} />
        </span>
        {live.state_ts ? (
          <>
            Live data from <Time iso={live.state_ts} /> ({fmtRelative(live.state_ts, now)})
          </>
        ) : (
          'No live data received yet'
        )}
        <span aria-hidden>·</span> last message {fmtRelative(live.last_seen_at, now)}
      </p>

      {/* Values the robot does not report (e.g. battery temperature on Saibya) are left out rather than shown as "—". */}
      <section aria-label="Live metrics" className={cn('grid gap-3 sm:grid-cols-2', live.signal_dbm !== null ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
        <BatteryTile live={live} href={tabHref(id, 'telemetry')} />
        {live.signal_dbm !== null && <SignalTile dbm={live.signal_dbm} />}
        <ArmedTile armed={live.armed} mode={live.mode} href={tabHref(id, 'events')} />
        <MotionTile speed={live.position?.speed_mps ?? null} heading={live.position?.heading_deg ?? null} href={tabHref(id, 'telemetry')} />
      </section>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card
          title="Position"
          className="xl:col-span-2"
          actions={
            <>
              {live.position?.fix && <FixBadge fix={live.position.fix} />}
              <CardLink href={tabHref(id, 'telemetry')}>GPS track</CardLink>
            </>
          }
        >
          {live.position ? (
            <>
              <GeoMap points={points} className="h-80" ariaLabel={`Map showing ${id} at ${fmtCoord(live.position.lat, live.position.lon)}`} />
              <dl className="mt-3 grid gap-3 sm:grid-cols-3">
                <Fact label="Coordinates" value={<span className="font-mono text-sm">{fmtCoord(live.position.lat, live.position.lon)}</span>} />
                {live.position.sats !== null && <Fact label="Satellites" value={live.position.sats} />}
                {live.position.alt_m !== null && <Fact label="Altitude" value={fmtNum(live.position.alt_m, 'm')} />}
                {live.position.hdop !== null && <Fact label="HDOP" value={fmtNum(live.position.hdop, '', 2)} />}
              </dl>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <MapPin className="size-4" aria-hidden /> No position reported yet.
            </p>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <DeviceHealthCard health={live.health} href={tabHref(id, 'telemetry')} />
          <TemperatureCard temps={live.temps_c} href={tabHref(id, 'telemetry')} />
        </div>
      </div>

      <MissionsCard robot={robot} />
    </div>
  );
}

// ── metric tiles ────────────────────────────────────────────────────────────

function Tile({ href, label, icon, children, title }: { href?: string; label: string; icon: ReactNode; children: ReactNode; title?: string }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
          <span aria-hidden>{icon}</span>
          {label}
        </p>
        {href && <ChevronRight className="size-4 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />}
      </div>
      <div className="mt-2">{children}</div>
    </>
  );
  const cls = 'group block rounded-lg border border-border bg-surface p-4 transition-colors';
  return href ? (
    <Link href={href} title={title} className={cn(cls, 'hover:border-accent/50 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent')}>
      {body}
    </Link>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  );
}

function BatteryTile({ live, href }: { live: LiveStateDto; href: string }) {
  const pct = live.battery.pct;
  const tone: Tone = pct === null ? 'muted' : pct < 20 ? 'fault' : pct < 40 ? 'warn' : 'ok';
  const Icon = live.battery.charging ? BatteryCharging : pct === null ? BatteryMedium : pct < 20 ? BatteryLow : pct < 60 ? BatteryMedium : BatteryFull;
  return (
    <Tile href={href} label="Battery" icon={<Icon className={cn('size-4', TONE_TEXT[tone])} />} title="Open battery history">
      <p className="text-2xl font-semibold tabular-nums">{pct === null ? '—' : `${Math.round(pct)} %`}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label="Battery charge">
        <div className={cn('h-full rounded-full transition-all', TONE_BG[tone])} style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">
        {fmtNum(live.battery.voltage_v, 'V', 1)}
        {live.battery.charging ? ' · charging' : ''}
      </p>
    </Tile>
  );
}

function SignalTile({ dbm }: { dbm: number }) {
  const bars = dbm >= -60 ? 4 : dbm >= -70 ? 3 : dbm >= -80 ? 2 : 1;
  const label = ['', 'Weak', 'Fair', 'Good', 'Excellent'][bars];
  const tone: Tone = bars >= 3 ? 'ok' : bars === 2 ? 'warn' : 'fault';
  return (
    <Tile label="Wi-Fi signal" icon={<SignalBars bars={bars} tone={tone} small />}>
      <div className="flex items-end justify-between">
        <p className="text-2xl font-semibold tabular-nums">
          {Math.round(dbm)} <span className="text-base font-medium text-muted">dBm</span>
        </p>
        <SignalBars bars={bars} tone={tone} />
      </div>
      <p className={cn('mt-1.5 text-xs font-medium', TONE_TEXT[tone])}>{label}</p>
    </Tile>
  );
}

function SignalBars({ bars, tone, small }: { bars: number; tone: Tone; small?: boolean }) {
  return (
    <span className={cn('flex items-end gap-0.5', small ? 'h-4' : 'h-7')} aria-hidden>
      {[1, 2, 3, 4].map((b) => (
        <span key={b} className={cn('rounded-sm', small ? 'w-1' : 'w-1.5', b <= bars ? TONE_BG[tone] : 'bg-border')} style={{ height: `${b * 25}%` }} />
      ))}
    </span>
  );
}

function ArmedTile({ armed, mode, href }: { armed: boolean | null; mode: string | null; href: string }) {
  const tone: Tone = armed === null ? 'muted' : armed ? 'warn' : 'ok';
  return (
    <Tile href={href} label="Armed / mode" icon={armed ? <ShieldOff className={cn('size-4', TONE_TEXT[tone])} /> : <ShieldCheck className={cn('size-4', TONE_TEXT[tone])} />} title="Open events">
      <p className={cn('text-2xl font-semibold', armed ? 'text-warn' : '')}>{armed === null ? '—' : armed ? 'Armed' : 'Disarmed'}</p>
      <p className="mt-2 text-xs text-muted">{mode ? <Badge tone="accent">{humanize(mode)}</Badge> : 'Mode not reported'}</p>
    </Tile>
  );
}

function MotionTile({ speed, heading, href }: { speed: number | null; heading: number | null; href: string }) {
  return (
    <Tile href={href} label="Speed / heading" icon={<Gauge className="size-4" />} title="Open GPS track">
      <div className="flex items-end justify-between">
        <p className="text-2xl font-semibold tabular-nums">
          {speed === null ? '—' : speed.toFixed(2)} <span className="text-base font-medium text-muted">m/s</span>
        </p>
        {heading !== null && (
          <span className="flex size-9 items-center justify-center rounded-full border border-border" title={`Heading ${Math.round(heading)}°`}>
            <Navigation className="size-4 text-accent-text transition-transform" style={{ transform: `rotate(${heading}deg)` }} aria-hidden />
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted">{heading === null ? 'Heading not reported' : `Heading ${Math.round(heading)}° ${compass(heading)}`}</p>
    </Tile>
  );
}

const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// ── position ────────────────────────────────────────────────────────────────

function FixBadge({ fix }: { fix: string }) {
  const f = fix.toLowerCase();
  const tone = f.includes('rtk_fix') || f === 'rtk_fixed' ? 'ok' : f.includes('float') || f === 'dgps' || f === '3d' ? 'warn' : f === 'none' || f.includes('no_fix') || f === 'stale' ? 'fault' : 'accent';
  return <Badge tone={tone}>{f === 'none' ? 'No GPS fix' : `Fix: ${humanize(fix)}`}</Badge>;
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-0.5 text-xs font-medium text-accent-text hover:underline">
      {children}
      <ChevronRight className="size-3.5" aria-hidden />
    </Link>
  );
}

// ── device health ───────────────────────────────────────────────────────────

const DEVICES: { key: keyof DeviceHealthDto; name: string; detail: string; Icon: typeof Cpu }[] = [
  { key: 'controller', name: 'Controller', detail: 'Jetson + motor controller link', Icon: Cpu },
  { key: 'lidar', name: 'LiDAR', detail: 'Obstacle scanner', Icon: Radar },
  { key: 'cameras', name: 'Cameras', detail: 'Cameras 1–4', Icon: Camera },
  { key: 'gps', name: 'GPS', detail: 'RTK GNSS receiver', Icon: Satellite },
];
const LEVEL: Record<HealthLevel, { tone: Tone; label: string; Icon: typeof CheckCircle2 }> = {
  ok: { tone: 'ok', label: 'OK', Icon: CheckCircle2 },
  warning: { tone: 'warn', label: 'Warning', Icon: AlertTriangle },
  fault: { tone: 'fault', label: 'Fault', Icon: XCircle },
};

function DeviceHealthCard({ health, href }: { health: DeviceHealthDto; href: string }) {
  const problems = DEVICES.filter((d) => health[d.key] === 'fault' || health[d.key] === 'warning').length;
  const unknown = DEVICES.every((d) => !health[d.key]);
  return (
    <Card
      title="Device health"
      actions={
        <>
          {!unknown && (problems ? <Badge tone="fault">{problems} need attention</Badge> : <Badge tone="ok">All OK</Badge>)}
          <CardLink href={href}>History</CardLink>
        </>
      }
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-border" aria-label="Device health">
        {DEVICES.map((d) => {
          const level = health[d.key];
          const l = level ? LEVEL[level] : null;
          return (
            <li key={d.key} className={cn('flex items-center gap-3 px-4 py-2.5', l?.tone === 'fault' && 'bg-fault-bg/40', l?.tone === 'warn' && 'bg-warn-bg/40')}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted" aria-hidden>
                <d.Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{d.name}</span>
                <span className="block text-xs text-muted">{d.detail}</span>
              </span>
              {l ? (
                <span className={cn('inline-flex items-center gap-1 text-sm font-semibold', TONE_TEXT[l.tone])}>
                  <l.Icon className="size-4" aria-hidden />
                  {l.label}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-sm text-muted" title="The robot does not report this device">
                  <CircleDashed className="size-4" aria-hidden />
                  Unknown
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ── temperatures ────────────────────────────────────────────────────────────

/** Warning / critical limits. Jetson limits are the GCS's OVER_TEMPERATURE thresholds (75 / 85 °C). */
const TEMP_LIMITS = { controller: [75, 85], battery: [45, 55], motor: [70, 90] } as const;

function TemperatureCard({ temps, href }: { temps: LiveStateDto['temps_c']; href: string }) {
  const rows: { name: string; detail: string; value: number; limits: readonly [number, number] }[] = [];
  if (temps.controller !== null) rows.push({ name: 'Jetson', detail: 'Onboard computer (CPU)', value: temps.controller, limits: TEMP_LIMITS.controller });
  if (temps.battery !== null) rows.push({ name: 'Battery', detail: 'Battery pack', value: temps.battery, limits: TEMP_LIMITS.battery });
  for (const [name, v] of Object.entries(temps.motors ?? {})) rows.push({ name: `Motor ${name}`, detail: 'Drive motor', value: v, limits: TEMP_LIMITS.motor });
  return (
    <Card title="Temperatures" actions={<CardLink href={href}>History</CardLink>}>
      {rows.length ? (
        <ul className="flex flex-col gap-4">
          {rows.map((r) => (
            <TempRow key={r.name} {...r} />
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <Thermometer className="size-4" aria-hidden /> No temperatures reported yet.
        </p>
      )}
    </Card>
  );
}

function TempRow({ name, detail, value, limits }: { name: string; detail: string; value: number; limits: readonly [number, number] }) {
  const [warn, crit] = limits;
  const tone: Tone = value >= crit ? 'fault' : value >= warn ? 'warn' : 'ok';
  const label = tone === 'fault' ? 'Critical' : tone === 'warn' ? 'Hot' : 'Normal';
  const max = Math.max(100, crit + 10);
  const pos = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <span>
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Thermometer className={cn('size-4', TONE_TEXT[tone])} aria-hidden />
            {name}
          </span>
          <span className="block text-xs text-muted">{detail}</span>
        </span>
        <span className="text-right">
          <span className="text-xl font-semibold tabular-nums">{value.toFixed(1)} °C</span>
          <span className={cn('block text-xs font-medium', TONE_TEXT[tone])}>{label}</span>
        </span>
      </div>
      <div
        className="relative mt-2 h-2 rounded-full bg-surface-2"
        role="meter"
        aria-label={`${name} temperature`}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        title={`Warning at ${warn} °C, critical at ${crit} °C`}
      >
        <div className={cn('h-full rounded-full transition-all', TONE_BG[tone])} style={{ width: pos(value) }} />
        <span className="absolute -top-0.5 h-3 w-px bg-warn" style={{ left: pos(warn) }} aria-hidden />
        <span className="absolute -top-0.5 h-3 w-px bg-fault" style={{ left: pos(crit) }} aria-hidden />
      </div>
      <p className="mt-1 flex justify-between text-[11px] text-muted" aria-hidden>
        <span>0 °C</span>
        <span>
          warn {warn} · crit {crit} °C
        </span>
      </p>
    </li>
  );
}

// ── missions & software ─────────────────────────────────────────────────────

function MissionsCard({ robot }: { robot: RobotDetailDto }) {
  const done = robot.completed + robot.failed + robot.aborted;
  const share = (n: number) => (done ? `${(n / done) * 100}%` : '0%');
  const id = robot.robot_id;
  return (
    <Card title="Missions & software" actions={<CardLink href={tabHref(id, 'missions')}>All missions</CardLink>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Stat label="Missions" value={robot.total_missions} sub={robot.in_progress ? `${robot.in_progress} in progress` : undefined} />
            {/* Two different distances: the robot's own odometer (all driving) and driving inside missions. */}
            <Stat label="Total driven" value={robot.odometer_m !== null ? fmtDistance(robot.odometer_m) : '—'} sub={robot.odometer_m !== null ? 'Odometer, all driving' : 'Not reported by the robot'} />
            <Stat label="Mission distance" value={fmtDistance(robot.total_distance_m)} sub="Driven on missions" />
            <Stat label="Mission time" value={fmtDuration(robot.total_duration_s)} />
            <Stat label="Average mission" value={fmtDuration(robot.avg_duration_s)} />
          </div>
          {done > 0 && (
            <div className="mt-4">
              <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${robot.completed} completed, ${robot.failed} failed, ${robot.aborted} aborted`}>
                <span className="bg-ok" style={{ width: share(robot.completed) }} />
                <span className="bg-fault" style={{ width: share(robot.failed) }} />
                <span className="bg-warn" style={{ width: share(robot.aborted) }} />
              </div>
              <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
                <Legend tone="ok" label={`${robot.completed} completed`} />
                <Legend tone="fault" label={`${robot.failed} failed`} />
                <Legend tone="warn" label={`${robot.aborted} aborted`} />
              </p>
            </div>
          )}
        </div>
        <Link href={tabHref(id, 'software')} className="group rounded-lg border border-border p-3 transition-colors hover:border-accent/50 hover:bg-surface-2">
          <p className="flex items-center justify-between text-xs font-medium tracking-wide text-muted uppercase">
            Software <ChevronRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted">Software</dt>
            <dd className="font-mono">{robot.sw_ver ?? '—'}</dd>
            <dt className="text-muted">Firmware</dt>
            <dd className="font-mono">{robot.fw_ver ?? '—'}</dd>
            <dt className="text-muted">Registered</dt>
            <dd>
              <Time iso={robot.created_at} />
            </dd>
          </dl>
        </Link>
      </div>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-accent-text">{sub}</p>}
    </div>
  );
}

function Legend({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-2 rounded-full', TONE_BG[tone])} />
      {label}
    </span>
  );
}
