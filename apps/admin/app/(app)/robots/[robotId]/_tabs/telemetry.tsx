'use client';

import type { BatteryPointDto, EncoderPointDto, GpsPointDto, HealthLevel, HealthPointDto, TelemetrySeriesDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { GeoMap, MapLegend } from '@/components/domain/geo-map';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtDistance, fmtNum, fromLocalInput, toLocalInput } from '@/lib/format';

const PRESETS = [
  { id: '1h', label: '1 h', ms: 3_600_000 },
  { id: '6h', label: '6 h', ms: 6 * 3_600_000 },
  { id: '24h', label: '24 h', ms: 24 * 3_600_000 },
  { id: '7d', label: '7 d', ms: 7 * 24 * 3_600_000 },
] as const;

const SERIES_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#a855f7', '#06b6d4', '#84cc16', '#ec4899'];

function useSeries<T>(robotId: string, kind: string, from: string, to: string) {
  return useQuery({
    queryKey: ['robot', robotId, 'telemetry', kind, from, to],
    queryFn: () => api.get<TelemetrySeriesDto<T>>(`/robots/${robotId}/telemetry/${kind}`, { from, to }),
    staleTime: 15_000,
  });
}

export function TelemetryTab({ robotId }: { robotId: string }) {
  const [preset, setPreset] = useState<string>('24h');
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  // Anchor "now" when the range is chosen so query keys stay stable between renders.
  const [anchor, setAnchor] = useState(() => Date.now());

  const { from, to } = useMemo(() => {
    if (preset === 'custom' && custom) return custom;
    const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[2];
    return { from: new Date(anchor - p.ms).toISOString(), to: new Date(anchor).toISOString() };
  }, [preset, custom, anchor]);

  const gps = useSeries<GpsPointDto>(robotId, 'gps', from, to);
  const battery = useSeries<BatteryPointDto>(robotId, 'battery', from, to);
  const encoders = useSeries<EncoderPointDto>(robotId, 'encoders', from, to);
  const health = useSeries<HealthPointDto>(robotId, 'health', from, to);

  const [draftFrom, setDraftFrom] = useState(toLocalInput(from));
  const [draftTo, setDraftTo] = useState(toLocalInput(to));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Time range" className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={preset === p.id ? 'primary' : 'secondary'}
              aria-pressed={preset === p.id}
              onClick={() => {
                setPreset(p.id);
                setAnchor(Date.now());
              }}
            >
              Last {p.label}
            </Button>
          ))}
          <Button size="sm" variant={preset === 'custom' ? 'primary' : 'secondary'} aria-pressed={preset === 'custom'} onClick={() => setPreset('custom')}>
            Custom
          </Button>
        </div>
        {preset === 'custom' && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = fromLocalInput(draftFrom);
              const t = fromLocalInput(draftTo);
              if (f && t && f < t) setCustom({ from: f, to: t });
            }}
          >
            <Field label="From (local)">
              <Input type="datetime-local" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
            </Field>
            <Field label="To (local)">
              <Input type="datetime-local" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary">
              Apply
            </Button>
          </form>
        )}
        <p className="text-xs text-muted" aria-live="polite">
          {fmtDateTime(from)} → {fmtDateTime(to)}
        </p>
      </div>

      <Card title="GPS track">
        <Section q={gps} empty="No GPS samples in this range.">
          {(s) => <GpsTrack points={s.points} robotId={robotId} />}
        </Section>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Battery">
          <Section q={battery} empty="No battery samples in this range.">
            {(s) => (
              <TimeChart
                label="Battery percentage and voltage over time"
                data={s.points.map((p) => ({ t: Date.parse(p.ts), pct: p.pct, v: p.voltage_v }))}
                from={from}
                to={to}
                lines={[
                  { key: 'pct', name: 'Battery (%)', color: SERIES_COLORS[0], axis: 'left' },
                  { key: 'v', name: 'Voltage (V)', color: SERIES_COLORS[1], axis: 'right' },
                ]}
                leftUnit="%"
                rightUnit="V"
                summary={summarize(s.points.map((p) => p.pct), '%')}
              />
            )}
          </Section>
        </Card>

        <Card title="Temperatures">
          <Section q={health} empty="No temperature samples in this range.">
            {(s) => (
              <TimeChart
                label="Controller, battery and hottest motor temperature over time"
                data={s.points.map((p) => ({ t: Date.parse(p.ts), c: p.temp_controller_c, b: p.temp_battery_c, m: p.temp_motors_max_c }))}
                from={from}
                to={to}
                lines={[
                  { key: 'c', name: 'Controller (°C)', color: SERIES_COLORS[3], axis: 'left' },
                  { key: 'b', name: 'Battery (°C)', color: SERIES_COLORS[2], axis: 'left' },
                  { key: 'm', name: 'Motors max (°C)', color: SERIES_COLORS[4], axis: 'left' },
                ]}
                leftUnit="°C"
                summary={summarize(s.points.map((p) => p.temp_controller_c), '°C', 'Controller')}
              />
            )}
          </Section>
        </Card>

        <Card title="Encoder velocity">
          <Section q={encoders} empty="No encoder samples in this range.">
            {(s) => <EncoderChart points={s.points} from={from} to={to} />}
          </Section>
        </Card>

        <Card title="Health timeline">
          <Section q={health} empty="No health samples in this range.">
            {(s) => <HealthTimeline points={s.points} />}
          </Section>
        </Card>
      </div>
    </div>
  );
}

function Section<T>({ q, empty, children }: { q: { data?: TelemetrySeriesDto<T>; isLoading: boolean; error: unknown; refetch: () => unknown }; empty: string; children: (s: TelemetrySeriesDto<T>) => ReactNode }) {
  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data || q.data.points.length === 0) return <EmptyState title={empty} description="Telemetry arrives in 30-second batches. Try a wider range." />;
  return (
    <>
      {children(q.data)}
      <p className="mt-2 text-xs text-muted">
        {q.data.points.length.toLocaleString()} points{q.data.bucket_s ? `, averaged per ${q.data.bucket_s >= 60 ? `${q.data.bucket_s / 60} min` : `${q.data.bucket_s} s`}` : ' (raw samples)'}
      </p>
    </>
  );
}

function summarize(values: (number | null)[], unit: string, prefix = ''): string {
  const v = values.filter((x): x is number => x !== null && x !== undefined);
  if (!v.length) return 'No values';
  const min = Math.min(...v);
  const max = Math.max(...v);
  const last = v[v.length - 1];
  return `${prefix ? `${prefix}: ` : ''}latest ${fmtNum(last, unit)}, min ${fmtNum(min, unit)}, max ${fmtNum(max, unit)}`;
}

function haversine(a: GpsPointDto, b: GpsPointDto): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function GpsTrack({ points, robotId }: { points: GpsPointDto[]; robotId: string }) {
  const { lines, markers, dist } = useMemo(() => {
    const coords = points.map((p) => [p.lon, p.lat]);
    let d = 0;
    for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
    const first = points[0];
    const last = points[points.length - 1];
    return {
      lines: [{ id: 'track', coordinates: coords, color: 'var(--map-actual)', width: 3 }],
      markers: [
        { id: 'first', lon: first.lon, lat: first.lat, color: '#16a34a', label: 'First' },
        { id: 'last', lon: last.lon, lat: last.lat, color: '#dc2626', label: 'Latest' },
      ],
      dist: d,
    };
  }, [points]);
  return (
    <>
      <GeoMap lines={lines} points={markers} className="h-80" ariaLabel={`GPS track of ${robotId}: ${points.length} points, about ${fmtDistance(dist)}`} />
      <MapLegend items={[{ label: `Track · ${points.length} points · ≈ ${fmtDistance(dist)}`, color: 'var(--map-actual)' }]} />
    </>
  );
}

interface LineSpec {
  key: string;
  name: string;
  color: string;
  axis: 'left' | 'right';
}

const tickTime = (from: string, to: string) => {
  const span = Date.parse(to) - Date.parse(from);
  const opts: Intl.DateTimeFormatOptions = span > 2 * 86_400_000 ? { month: 'short', day: '2-digit', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
  const f = new Intl.DateTimeFormat(undefined, opts);
  return (v: number) => f.format(new Date(v));
};

function TimeChart({
  data,
  lines,
  from,
  to,
  label,
  leftUnit,
  rightUnit,
  summary,
}: {
  data: Record<string, number | null>[];
  lines: LineSpec[];
  from: string;
  to: string;
  label: string;
  leftUnit: string;
  rightUnit?: string;
  summary: string;
}) {
  const fmt = tickTime(from, to);
  return (
    <figure>
      <div className="h-64" role="img" aria-label={`${label}. ${summary}.`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="t" type="number" scale="time" domain={[Date.parse(from), Date.parse(to)]} tickFormatter={fmt} stroke="var(--text-muted)" fontSize={11} />
            <YAxis yAxisId="left" stroke="var(--text-muted)" fontSize={11} unit={` ${leftUnit}`} width={64} />
            {rightUnit && <YAxis yAxisId="right" orientation="right" stroke="var(--text-muted)" fontSize={11} unit={` ${rightUnit}`} width={56} />}
            <Tooltip
              labelFormatter={(v) => fmtDateTime(new Date(Number(v)).toISOString())}
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {lines.map((l) => (
              <Line key={l.key} yAxisId={l.axis} dataKey={l.key} name={l.name} stroke={l.color} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-1 text-xs text-muted">{summary}</figcaption>
    </figure>
  );
}

function EncoderChart({ points, from, to }: { points: EncoderPointDto[]; from: string; to: string }) {
  const { rows, names } = useMemo(() => {
    const byTs = new Map<number, Record<string, number | null>>();
    const names = new Set<string>();
    for (const p of points) {
      const t = Date.parse(p.ts);
      names.add(p.encoder);
      const row = byTs.get(t) ?? { t };
      row[p.encoder] = p.velocity_mps;
      byTs.set(t, row);
    }
    return { rows: [...byTs.values()].sort((a, b) => (a.t as number) - (b.t as number)), names: [...names].sort() };
  }, [points]);
  return (
    <TimeChart
      label="Encoder velocity over time"
      data={rows}
      from={from}
      to={to}
      leftUnit="m/s"
      lines={names.map((n, i) => ({ key: n, name: `${n} (m/s)`, color: SERIES_COLORS[i % SERIES_COLORS.length], axis: 'left' as const }))}
      summary={`${names.length} encoder(s): ${names.join(', ')}`}
    />
  );
}

const HEALTH_CELL: Record<HealthLevel, string> = { ok: 'bg-ok', warning: 'bg-warn', fault: 'bg-fault' };
const DEVICES = [
  ['controller', 'Controller'],
  ['lidar', 'LiDAR'],
  ['cameras', 'Cameras'],
  ['gps', 'GPS'],
] as const;

function HealthTimeline({ points }: { points: HealthPointDto[] }) {
  return (
    <div className="flex flex-col gap-3">
      {DEVICES.map(([key, label]) => {
        const values = points.map((p) => p[key]);
        const counts = { ok: 0, warning: 0, fault: 0, unknown: 0 };
        for (const v of values) counts[v ?? 'unknown']++;
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
                return <span key={i} className={cn('h-full flex-1', v ? HEALTH_CELL[v] : 'bg-offline-bg')} title={`${fmtDateTime(p.ts)}: ${v ?? 'unknown'}`} />;
              })}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted">Left = oldest, right = newest. Colours: green OK, amber Warning, red Fault, grey unknown. Counts are listed above each bar.</p>
    </div>
  );
}
