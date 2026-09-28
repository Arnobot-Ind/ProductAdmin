'use client';

import type { LiveStateDto, RobotDetailDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Gauge, MapPin, Radio, ShieldCheck, ShieldOff, Thermometer } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { GeoMap } from '@/components/domain/geo-map';
import { HealthChips } from '@/components/domain/status';
import { Badge, Card, KeyValue, QueryView, Time } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { fmtCoord, fmtDistance, fmtDuration, fmtNum, fmtPct, humanize } from '@/lib/format';
import { useLivePoll } from '@/lib/realtime';

function Metric({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
      <span className="mt-0.5 text-muted" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
        <p className="text-lg font-semibold tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted">{sub}</p>}
      </div>
    </div>
  );
}

function signalLabel(dbm: number | null): string {
  if (dbm === null) return 'Not reported';
  if (dbm >= -60) return 'Excellent';
  if (dbm >= -70) return 'Good';
  if (dbm >= -80) return 'Fair';
  return 'Weak';
}

export function OverviewTab({ robot }: { robot: RobotDetailDto }) {
  const poll = useLivePoll();
  const q = useQuery({
    queryKey: ['robot', robot.robot_id, 'live'],
    queryFn: () => api.get<LiveStateDto>(`/robots/${robot.robot_id}/live`),
    refetchInterval: poll,
  });

  return (
    <QueryView query={q} rows={6}>
      {(live) => <LiveView live={live} robot={robot} />}
    </QueryView>
  );
}

function LiveView({ live, robot }: { live: LiveStateDto; robot: RobotDetailDto }) {
  const pct = live.battery.pct;
  const BatteryIcon = live.battery.charging ? BatteryCharging : pct === null ? BatteryMedium : pct < 20 ? BatteryLow : pct < 60 ? BatteryMedium : BatteryFull;
  const points = useMemo(
    () => (live.position ? [{ id: 'robot', lon: live.position.lon, lat: live.position.lat, color: 'var(--map-actual)', label: robot.robot_id }] : []),
    [live.position, robot.robot_id],
  );
  const motors = live.temps_c.motors ? Object.entries(live.temps_c.motors) : [];

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        Live state from the newest <code>live</code> message
        {live.state_ts ? (
          <>
            {' '}
            captured <Time iso={live.state_ts} />
          </>
        ) : (
          ': no live message received yet'
        )}
        . Last message of any type: <Time iso={live.last_seen_at} relative />.
      </p>

      <section aria-label="Live metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={<BatteryIcon className="size-5" />}
          label="Battery"
          value={fmtPct(pct)}
          sub={
            <>
              {fmtNum(live.battery.voltage_v, 'V', 2)}
              {live.battery.charging ? ' · charging' : live.battery.charging === false ? ' · not charging' : ''}
            </>
          }
        />
        <Metric icon={<Radio className="size-5" />} label="Signal" value={fmtNum(live.signal_dbm, 'dBm', 0)} sub={signalLabel(live.signal_dbm)} />
        <Metric
          icon={live.armed ? <ShieldOff className="size-5" /> : <ShieldCheck className="size-5" />}
          label="Armed / mode"
          value={live.armed === null ? '—' : live.armed ? 'Armed' : 'Disarmed'}
          sub={live.mode ? `Mode: ${humanize(live.mode)}` : 'Mode not reported'}
        />
        <Metric
          icon={<Gauge className="size-5" />}
          label="Speed / heading"
          value={fmtNum(live.position?.speed_mps ?? null, 'm/s', 2)}
          sub={live.position?.heading_deg !== null && live.position?.heading_deg !== undefined ? `Heading ${fmtNum(live.position.heading_deg, '°', 0)}` : undefined}
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Position" className="xl:col-span-2" actions={live.position?.fix ? <Badge tone="accent">{humanize(live.position.fix)}</Badge> : undefined}>
          {live.position ? (
            <>
              <GeoMap points={points} className="h-72" ariaLabel={`Map showing ${robot.robot_id} at ${fmtCoord(live.position.lat, live.position.lon)}`} />
              <div className="mt-3">
                <KeyValue
                  columns={3}
                  items={[
                    { label: 'Coordinates', value: <span className="font-mono text-sm">{fmtCoord(live.position.lat, live.position.lon)}</span> },
                    { label: 'Altitude', value: fmtNum(live.position.alt_m, 'm') },
                    { label: 'Fix quality', value: live.position.fix ? humanize(live.position.fix) : null },
                    { label: 'HDOP', value: fmtNum(live.position.hdop, '', 2) },
                    { label: 'Satellites', value: live.position.sats },
                  ]}
                />
              </div>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <MapPin className="size-4" aria-hidden /> No position reported yet.
            </p>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          <Card title="Device health">
            <HealthChips health={live.health} />
          </Card>
          <Card title="Temperatures">
            <KeyValue
              columns={2}
              items={[
                { label: 'Controller', value: fmtNum(live.temps_c.controller, '°C') },
                { label: 'Battery', value: fmtNum(live.temps_c.battery, '°C') },
                ...motors.map(([name, t]) => ({ label: `Motor ${name}`, value: fmtNum(t, '°C') })),
              ]}
            />
            {!motors.length && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                <Thermometer className="size-3.5" aria-hidden /> No motor temperatures reported.
              </p>
            )}
          </Card>
        </div>
      </div>

      <Card title="Missions & software">
        <KeyValue
          columns={3}
          items={[
            { label: 'Total missions', value: robot.total_missions },
            { label: 'Completed / failed / aborted', value: `${robot.completed} / ${robot.failed} / ${robot.aborted}` },
            { label: 'In progress', value: robot.in_progress },
            { label: 'Total distance', value: fmtDistance(robot.total_distance_m) },
            { label: 'Total mission time', value: fmtDuration(robot.total_duration_s) },
            { label: 'Average mission', value: fmtDuration(robot.avg_duration_s) },
            { label: 'Software version', value: robot.sw_ver },
            { label: 'Firmware version', value: robot.fw_ver },
            { label: 'Registered', value: <Time iso={robot.created_at} /> },
          ]}
        />
      </Card>
    </div>
  );
}
