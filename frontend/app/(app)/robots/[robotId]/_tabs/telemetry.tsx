'use client';

import { fmtSerial } from '@/lib/format';
import type { BatteryPointDto, EncoderPointDto, GpsPointDto, HealthLevel, HealthPointDto, TelemetrySeriesDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { GeoMap } from '@/components/domain/geo-map';
import { OptionFilter } from '@/components/ui/filter-menu';
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtDistance } from '@/lib/format';
import { periodBounds } from '@/lib/periods';

const RANGES = [
  { id: 'today', label: 'Today', title: 'today' },
  { id: 'yesterday', label: 'Yesterday', title: 'yesterday' },
  { id: '24h', label: '1 day', title: 'last 24 hours' },
  { id: '7d', label: '7 days', title: 'last 7 days' },
  { id: '30d', label: '1 month', title: 'last month' },
  { id: '90d', label: '3 months', title: 'last 3 months' },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

function useSeries<T>(robotId: string, kind: string, from: string, to: string) {
  return useQuery({
    queryKey: ['robot', robotId, 'telemetry', kind, from, to],
    queryFn: () => api.get<TelemetrySeriesDto<T>>(`/robots/${robotId}/telemetry/${kind}`, { from, to }),
    staleTime: 15_000,
  });
}

/**
 * Sensor history, as graphs or as a map. One time range for all of it: changing any Filter changes them all, and it is
 * kept when moving between Graphs and Map.
 */
export function TelemetryTab({ robotId, view }: { robotId: string; view: 'graphs' | 'map' }) {
  const [range, setRange] = useState<RangeId>('7d');
  // The window is fixed when the range is picked and moves forward once a minute, so new data appears.
  const [bounds, setBounds] = useState(() => periodBounds('7d'));
  useEffect(() => {
    setBounds(periodBounds(range));
    if (range === 'yesterday') return;
    const id = window.setInterval(() => setBounds(periodBounds(range)), 60_000);
    return () => window.clearInterval(id);
  }, [range]);
  const shared = { robotId, range, onRange: setRange, from: bounds.from!, to: bounds.to! };
  if (view === 'map') {
    return (
      <RangeCard<GpsPointDto> {...shared} kind="gps" title="Where it ran" empty="No position data in this time range.">
        {(s) => <GpsTrack points={s.points} robotId={robotId} />}
      </RangeCard>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <RangeCard<BatteryPointDto> {...shared} kind="battery" title="Battery" empty="No battery data in this time range.">
        {(s) => <SimpleChart name="Battery" unit="%" color="var(--chart-good)" series={s} points={s.points.map((p) => ({ t: Date.parse(p.ts), v: p.pct }))} />}
      </RangeCard>
      <RangeCard<HealthPointDto> {...shared} kind="health" title="Temperature" empty="No temperature data in this time range.">
        {(s) => (
          <SimpleChart
            name="Hottest part"
            unit="°C"
            color="#ea580c"
            series={s}
            points={s.points.map((p) => {
              const temps = [p.temp_controller_c, p.temp_battery_c, p.temp_motors_max_c].filter((x): x is number => x !== null && x !== undefined);
              return { t: Date.parse(p.ts), v: temps.length ? Math.max(...temps) : null };
            })}
          />
        )}
      </RangeCard>
      <RangeCard<EncoderPointDto> {...shared} kind="encoders" title="Speed" empty="No speed data in this time range.">
        {(s) => <SimpleChart name="Speed" unit="m/s" color="var(--cat-ugv)" series={s} points={averageSpeed(s.points)} />}
      </RangeCard>
      <RangeCard<HealthPointDto> {...shared} kind="health" title="Health" empty="No health data in this time range.">
        {(s) => <HealthTimeline series={s} />}
      </RangeCard>
    </div>
  );
}

/** A map or graph with the Filter button at its top right; the time range itself is shared by the whole tab. */
function RangeCard<T>({ robotId, kind, title, empty, range, onRange, from, to, children }: { robotId: string; kind: string; title: string; empty: string; range: RangeId; onRange: (r: RangeId) => void; from: string; to: string; children: (s: TelemetrySeriesDto<T>) => ReactNode }) {
  const q = useSeries<T>(robotId, kind, from, to);
  const chosen = RANGES.find((r) => r.id === range)!;
  return (
    <Card
      title={
        <>
          {title} <span className="font-normal text-muted">· {chosen.title}</span>
        </>
      }
      actions={<OptionFilter label={title} value={range} options={RANGES} onChange={onRange} />}
    >
      <Section q={q} empty={empty}>
        {children}
      </Section>
    </Card>
  );
}

function Section<T>({ q, empty, children }: { q: { data?: TelemetrySeriesDto<T>; isLoading: boolean; error: unknown; refetch: () => unknown }; empty: string; children: (s: TelemetrySeriesDto<T>) => ReactNode }) {
  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data || q.data.points.length === 0) return <EmptyState title={empty} description="Choose a longer time range with Filter." />;
  return <>{children(q.data)}</>;
}

/** Two readings further apart than this have a gap between them: the robot sent nothing in between. */
const gapMs = (bucketS: number) => Math.max(bucketS * 2, 120) * 1000;

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
    // The server splits the track where GPS was missing or a reading was impossible; a line is drawn only inside a piece.
    const bySegment = new Map<number, GpsPointDto[]>();
    for (const p of points) bySegment.set(p.segment, [...(bySegment.get(p.segment) ?? []), p]);
    const pieces = [...bySegment.values()].filter((x) => x.length > 1);
    const kept = pieces.length ? pieces.flat() : points;
    const first = kept[0];
    const last = kept[kept.length - 1];
    return {
      lines: pieces.map((x, i) => ({ id: `track-${i}`, coordinates: x.map((p) => [p.lon, p.lat]), color: 'var(--map-actual)', width: 3 })),
      markers: [
        { id: 'first', lon: first.lon, lat: first.lat, color: '#16a34a', label: 'First' },
        { id: 'last', lon: last.lon, lat: last.lat, color: '#dc2626', label: 'Latest' },
      ],
      dist: pieces.reduce((sum, x) => sum + x.slice(1).reduce((d, p, i) => d + haversine(x[i], p), 0), 0),
    };
  }, [points]);
  return (
    <>
      <GeoMap lines={lines} points={markers} className="h-[75vh] min-h-[480px]" ariaLabel={`GPS track of ${fmtSerial(robotId)}: ${points.length} points, about ${fmtDistance(dist)}`} />
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-base">
        <span className="font-semibold">About {fmtDistance(dist)}</span>
        <span className="inline-flex items-center gap-1.5 text-muted"><span className="size-3 rounded-full bg-[#16a34a]" aria-hidden /> Start</span>
        <span className="inline-flex items-center gap-1.5 text-muted"><span className="size-3 rounded-full bg-[#dc2626]" aria-hidden /> End</span>
      </p>
    </>
  );
}

const IST_ZONE = 'Asia/Kolkata';
const whenLabel = (t: number) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST_ZONE });

/** One wheel speed per moment: the average of all the wheels. */
function averageSpeed(points: EncoderPointDto[]): { t: number; v: number | null }[] {
  const byTime = new Map<number, number[]>();
  for (const p of points) {
    if (p.velocity_mps === null || p.velocity_mps === undefined) continue;
    const t = Date.parse(p.ts);
    byTime.set(t, [...(byTime.get(t) ?? []), Math.abs(p.velocity_mps)]);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v: v.reduce((x, y) => x + y, 0) / v.length }));
}

/** A graph anyone can read: the latest value in large type, one line over time, and the lowest and highest in words. */
function SimpleChart<T>({ name, unit, color, points, series }: { name: string; unit: string; color: string; points: { t: number; v: number | null }[]; series: TelemetrySeriesDto<T> }) {
  const known = points.filter((p): p is { t: number; v: number } => p.v !== null && p.v !== undefined);
  if (!known.length) return <EmptyState title="Not reported by this robot" />;
  const values = known.map((p) => p.v);
  const show = (v: number) => `${+v.toFixed(v >= 10 ? 0 : 1)} ${unit}`;
  const from = Date.parse(series.from);
  const to = Date.parse(series.to);
  const longRange = to - from > 2 * 86_400_000;
  const tick = (t: number) => new Date(t).toLocaleString('en-GB', longRange ? { day: 'numeric', month: 'short', timeZone: IST_ZONE } : { hour: '2-digit', minute: '2-digit', timeZone: IST_ZONE });
  // An empty row at each gap breaks the line, so a time with no data stays empty.
  const rows: { t: number; v: number | null }[] = [];
  known.forEach((p, i) => {
    const prev = known[i - 1];
    if (prev && p.t - prev.t > gapMs(series.bucket_s)) rows.push({ t: prev.t + 1, v: null });
    rows.push(p);
  });
  return (
    <figure>
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4">
        <span>
          <span className="text-3xl font-semibold tabular-nums">{show(values[values.length - 1])}</span>
          <span className="ml-2 text-base text-muted">latest</span>
        </span>
        <span className="text-base text-muted tabular-nums">
          Lowest {show(Math.min(...values))} · Highest {show(Math.max(...values))}
        </span>
      </figcaption>
      <div className="h-52" role="img" aria-label={`${name} over time. Latest ${show(values[values.length - 1])}, lowest ${show(Math.min(...values))}, highest ${show(Math.max(...values))}. Empty parts mean no data.`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={[from, to]} tickFormatter={tick} stroke="var(--text-muted)" fontSize={13} minTickGap={70} tickLine={false} />
            <YAxis stroke="var(--text-muted)" fontSize={13} unit={` ${unit}`} width={62} tickLine={false} axisLine={false} domain={unit === '%' ? [0, 100] : [0, 'auto']} />
            <Tooltip
              labelFormatter={(t) => whenLabel(Number(t))}
              formatter={(v) => [show(Number(v)), name]}
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }}
            />
            <Area
              dataKey="v"
              stroke={color}
              strokeWidth={2}
              fill={color}
              fillOpacity={0.12}
              connectNulls={false}
              isAnimationActive={false}
              // A lone reading between two gaps has no line to sit on, so it shows as a dot.
              dot={(d: { index: number; cx?: number; cy?: number }) => {
                const lone = rows[d.index]?.v !== null && rows[d.index - 1]?.v == null && rows[d.index + 1]?.v == null;
                return lone && d.cx !== undefined && d.cy !== undefined ? <circle key={d.index} cx={d.cx} cy={d.cy} r={3} fill={color} /> : <g key={d.index} />;
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

const HEALTH_CELL: Record<HealthLevel, string> = { ok: 'bg-ok', warning: 'bg-warn', fault: 'bg-fault' };
const DEVICES = [
  ['controller', 'Controller'],
  ['lidar', 'LiDAR'],
  ['cameras', 'Cameras'],
  ['gps', 'GPS'],
] as const;

/** Each device with one word for the period, and a bar across the time range: colour where there is data, empty where there is none. */
function HealthTimeline({ series }: { series: TelemetrySeriesDto<HealthPointDto> }) {
  const { points } = series;
  const from = Date.parse(series.from);
  const to = Date.parse(series.to);
  const span = Math.max(1, to - from);
  const width = Math.max(((series.bucket_s || 30) * 1000 * 100) / span, 0.3);
  const day = (t: number) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST_ZONE });
  return (
    <div className="flex flex-col gap-4">
      {DEVICES.map(([key, label]) => {
        const values = points.map((p) => p[key]);
        const word = values.includes('fault') ? 'Had faults' : values.includes('warning') ? 'Had warnings' : values.includes('ok') ? 'All good' : 'Not reported';
        const tone = word === 'Had faults' ? 'text-fault' : word === 'Had warnings' ? 'text-warn' : word === 'All good' ? 'text-ok' : 'text-muted';
        return (
          <div key={key}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-base">
              <span className="font-medium">{label}</span>
              <span className={cn('font-medium', tone)}>{word}</span>
            </div>
            <div className="relative h-3 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
              {points.map((p, i) => {
                const v = p[key];
                if (!v) return null;
                const left = ((Date.parse(p.ts) - from) * 100) / span;
                return <span key={i} className={cn('absolute inset-y-0', HEALTH_CELL[v])} style={{ left: `${left}%`, width: `${width}%` }} title={`${fmtDateTime(p.ts)}: ${v}`} />;
              })}
            </div>
          </div>
        );
      })}
      <p className="flex justify-between text-sm text-muted">
        <span>{day(from)}</span>
        <span>Empty = no data</span>
        <span>{day(to)}</span>
      </p>
    </div>
  );
}
