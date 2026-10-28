'use client';

import type { BatteryPointDto, GpsPointDto, HealthLevel, HealthPointDto, ReportPathPointDto, TelemetrySeriesDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useMemo, useState, type ReactNode } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

// Leaflet is client-only.
const ReportMap = dynamic(() => import('@/components/client/report-map').then((m) => m.ReportMap), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-xs text-muted">Loading map…</div>,
});

const RANGES = [
  { id: '24h', label: '24 hours', ms: 24 * 3_600_000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 3_600_000 },
  { id: '31d', label: '31 days', ms: 31 * 24 * 3_600_000 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const IST = 'Asia/Kolkata';
const fmtIst = (ms: number, opts: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleString('en-GB', { timeZone: IST, ...opts });

function useSeries<T>(robotId: string, kind: string, from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['robot', robotId, 'client-telemetry', kind, from, to],
    queryFn: () => api.get<TelemetrySeriesDto<T>>(`/robots/${robotId}/client/telemetry/${kind}`, { from, to }),
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Battery, temperatures and device health over a period (portal.telemetry.view, 0021); with portal.robots.location
 * also the GPS track. Charts only: no raw rows and no CSV for clients. The API buckets the data (≈ 1000 points).
 */
export function RobotTelemetryTab({ robotId, showTrack }: { robotId: string; showTrack: boolean }) {
  const [range, setRange] = useState<RangeId>('24h');
  // Anchor "now" when the range is chosen, so the query key stays stable between renders.
  const [anchor, setAnchor] = useState(() => Date.now());
  const { from, to } = useMemo(() => {
    const r = RANGES.find((x) => x.id === range)!;
    return { from: new Date(anchor - r.ms).toISOString(), to: new Date(anchor).toISOString() };
  }, [range, anchor]);

  const battery = useSeries<BatteryPointDto>(robotId, 'battery', from, to);
  const health = useSeries<HealthPointDto>(robotId, 'health', from, to);
  const gps = useSeries<GpsPointDto>(robotId, 'gps', from, to, showTrack);

  const batteryData = useMemo(() => (battery.data?.points ?? []).map((p) => ({ t: Date.parse(p.ts), pct: p.pct, voltage: p.voltage_v })), [battery.data]);
  const tempData = useMemo(
    () => (health.data?.points ?? []).map((p) => ({ t: Date.parse(p.ts), controller: p.temp_controller_c, battery: p.temp_battery_c, motors: p.temp_motors_max_c })),
    [health.data],
  );
  const track = useMemo<ReportPathPointDto[]>(() => (gps.data?.points ?? []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => ({ t: p.ts, lat: p.lat, lon: p.lon, est: false })), [gps.data]);
  // Bucketed points: a gap longer than a few buckets is the robot being off, not a straight drive.
  const breakGapMs = Math.max(30_000, (gps.data?.bucket_s ?? 30) * 3_000);

  return (
    <div className="flex flex-col gap-5">
      <div role="group" aria-label="Period" className="flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={range === r.id}
            onClick={() => {
              setRange(r.id);
              setAnchor(Date.now());
            }}
            className={cn(
              'rounded-full border px-3 py-1 text-sm transition-colors',
              range === r.id ? 'border-accent bg-accent-soft font-semibold text-accent-text' : 'border-border text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            Last {r.label}
          </button>
        ))}
      </div>

      <Card title="Battery">
        <Series query={battery} empty="No battery readings in this period.">
          <TimeChart
            data={batteryData}
            from={from}
            to={to}
            label="Battery charge and voltage"
            lines={[
              { key: 'pct', name: 'Charge (%)', color: '#10b981', axis: 'left' },
              { key: 'voltage', name: 'Voltage (V)', color: '#3b82f6', axis: 'right' },
            ]}
            leftUnit="%"
            rightUnit="V"
          />
        </Series>
      </Card>

      <Card title="Temperatures">
        <Series query={health} empty="No temperature readings in this period.">
          <TimeChart
            data={tempData}
            from={from}
            to={to}
            label="Controller, battery and hottest motor temperature"
            lines={[
              { key: 'controller', name: 'Controller', color: '#f59e0b', axis: 'left' },
              { key: 'battery', name: 'Battery', color: '#10b981', axis: 'left' },
              { key: 'motors', name: 'Motors (hottest)', color: '#ef4444', axis: 'left' },
            ]}
            leftUnit="°C"
          />
        </Series>
      </Card>

      <Card title="Device health">
        <Series query={health} empty="No health reports in this period.">
          <HealthStrip points={health.data?.points ?? []} />
        </Series>
      </Card>

      {showTrack && (
        <Card title="Where it drove">
          {gps.isLoading ? (
            <LoadingBlock rows={3} label="Loading track" />
          ) : gps.error ? (
            <ErrorState error={gps.error} onRetry={() => void gps.refetch()} />
          ) : track.length < 2 ? (
            <EmptyState title="No GPS track in this period" />
          ) : (
            <div className="h-96">
              <ReportMap points={track} breakGapMs={breakGapMs} height="100%" />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Series({ query, empty, children }: { query: { isLoading: boolean; error: unknown; data?: { points: unknown[] }; refetch: () => unknown }; empty: string; children: ReactNode }) {
  if (query.isLoading) return <LoadingBlock rows={3} label="Loading" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data?.points.length) return <EmptyState title={empty} />;
  return <>{children}</>;
}

interface LineSpec {
  key: string;
  name: string;
  color: string;
  axis: 'left' | 'right';
}

function TimeChart({ data, lines, from, to, label, leftUnit, rightUnit }: { data: Record<string, number | null>[]; lines: LineSpec[]; from: string; to: string; label: string; leftUnit: string; rightUnit?: string }) {
  const spanMs = Date.parse(to) - Date.parse(from);
  const tick = (v: number) => (spanMs <= 36 * 3_600_000 ? fmtIst(v, { hour: '2-digit', minute: '2-digit', hour12: false }) : fmtIst(v, { day: 'numeric', month: 'short' }));
  // Leave out series the robot never reports (e.g. motor temperature on some robots).
  const shown = lines.filter((l) => data.some((d) => d[l.key] !== null && d[l.key] !== undefined));
  if (!shown.length) return <EmptyState title="Not reported by this robot" />;
  return (
    <div className="h-64" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="t" type="number" scale="time" domain={[Date.parse(from), Date.parse(to)]} tickFormatter={tick} stroke="var(--text-muted)" fontSize={11} />
          <YAxis yAxisId="left" stroke="var(--text-muted)" fontSize={11} unit={` ${leftUnit}`} width={64} />
          {rightUnit && shown.some((l) => l.axis === 'right') && <YAxis yAxisId="right" orientation="right" stroke="var(--text-muted)" fontSize={11} unit={` ${rightUnit}`} width={56} />}
          <Tooltip
            labelFormatter={(v) => `${fmtIst(Number(v), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST`}
            formatter={(v) => (typeof v === 'number' ? +v.toFixed(1) : v)}
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {shown.map((l) => (
            <Line key={l.key} yAxisId={l.axis} dataKey={l.key} name={l.name} stroke={l.color} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const HEALTH_CELL: Record<HealthLevel, string> = { ok: 'bg-ok', warning: 'bg-warn', fault: 'bg-fault' };
const DEVICES = [
  ['controller', 'Controller'],
  ['lidar', 'LiDAR'],
  ['cameras', 'Cameras'],
  ['gps', 'GPS'],
] as const;

/** One strip per device: the worst state in each bucket, oldest left. */
function HealthStrip({ points }: { points: HealthPointDto[] }) {
  return (
    <div className="flex flex-col gap-3">
      {DEVICES.map(([key, label]) => {
        const counts = { ok: 0, warning: 0, fault: 0, unknown: 0 };
        for (const p of points) counts[p[key] ?? 'unknown']++;
        return (
          <div key={key}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{label}</span>
              <span className="text-xs text-muted">
                OK {counts.ok} · Warning {counts.warning} · Fault {counts.fault}
                {counts.unknown ? ` · Unknown ${counts.unknown}` : ''}
              </span>
            </div>
            <div className="flex h-4 w-full overflow-hidden rounded-sm bg-surface-2" aria-hidden>
              {points.map((p, i) => {
                const v = p[key];
                return (
                  <span
                    key={i}
                    className={cn('h-full flex-1', v ? HEALTH_CELL[v] : 'bg-offline-bg')}
                    title={`${fmtIst(Date.parse(p.ts), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} IST: ${v ?? 'unknown'}`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted">Oldest on the left, newest on the right. Green OK, amber warning, red fault, grey no report. Counts are per time slot.</p>
    </div>
  );
}
