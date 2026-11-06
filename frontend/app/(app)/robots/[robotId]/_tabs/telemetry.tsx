'use client';

import { Button } from '@/components/ui/button';
import { fmtSerial, fmtDuration } from '@/lib/format';
import type { BatteryPointDto, EncoderPointDto, GpsPointDto, HealthLevel, HealthPointDto, TelemetrySeriesDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
    // The window moves on every minute: what is on screen stays until the new data arrives, so nothing reloads visibly.
    placeholderData: keepPreviousData,
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

/** Runs within this distance of each other count as one place. */
const PLACE_RADIUS_M = 2000;
/** A longer break than this at one place starts a new visit, so a visit's times match the hours it ran. */
const VISIT_BREAK_MS = 30 * 60_000;

/** One visit to a place: runs close together in time. The same place visited on other days has other visits. */
interface Visit {
  id: string;
  name: string;
  runs: GpsPointDto[][];
  meters: number;
  seconds: number;
  from: number;
  to: number;
}

const runMeters = (run: GpsPointDto[]) => run.slice(1).reduce((d, p, i) => d + haversine(run[i], p), 0);
const runStart = (run: GpsPointDto[]) => Date.parse(run[0].ts);
const runEnd = (run: GpsPointDto[]) => Date.parse(run[run.length - 1].ts);

/** Groups runs by where they happened, then by when: most recent visit first, and the same place keeps its name. */
function groupVisits(runs: GpsPointDto[][]): { visits: Visit[]; placeCount: number } {
  const places: { centre: GpsPointDto; runs: GpsPointDto[][] }[] = [];
  for (const run of runs) {
    const centre = run[run.length >> 1];
    const near = places.find((g) => haversine(g.centre, centre) <= PLACE_RADIUS_M);
    if (near) near.runs.push(run);
    else places.push({ centre, runs: [run] });
  }
  const latest = (g: { runs: GpsPointDto[][] }) => Math.max(...g.runs.map(runEnd));
  const ordered = [...places].sort((a, b) => latest(b) - latest(a));
  const visits = ordered.flatMap((place, i) => {
    const groups: GpsPointDto[][][] = [];
    for (const run of [...place.runs].sort((a, b) => runStart(a) - runStart(b))) {
      const open = groups[groups.length - 1];
      if (open && runStart(run) - Math.max(...open.map(runEnd)) <= VISIT_BREAK_MS) open.push(run);
      else groups.push([run]);
    }
    return groups.map((group) => {
      const from = runStart(group[0]);
      return {
        id: String(from),
        name: `Place ${i + 1}`,
        runs: group,
        meters: group.reduce((sum, r) => sum + runMeters(r), 0),
        seconds: group.reduce((sum, r) => sum + (runEnd(r) - runStart(r)) / 1000, 0),
        from,
        to: Math.max(...group.map(runEnd)),
      };
    });
  });
  return { visits: visits.sort((a, b) => b.to - a.to), placeCount: places.length };
}

/** Size of the picture on a place card, in map pixels. */
const CARD_W = 640;
const CARD_H = 400;

/** Web Mercator: a position in pixels of the whole world map at this zoom. */
function worldPixel(lat: number, lon: number, zoom: number): [number, number] {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * size, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size];
}

/**
 * The real satellite picture of a place with its route on top, zoomed to fit the route. Plain images, not a live map:
 * a browser allows only a few live maps on a page, and this card only has to be looked at and clicked.
 */
function PlaceMap({ runs }: { runs: GpsPointDto[][] }) {
  // A robot can have many visits: its satellite images load only when the card scrolls into view.
  const box = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !box.current) return;
    const watch = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setSeen(true), { rootMargin: '300px' });
    watch.observe(box.current);
    return () => watch.disconnect();
  }, [seen]);
  const all = runs.flat();
  const [minLat, maxLat] = [Math.min(...all.map((p) => p.lat)), Math.max(...all.map((p) => p.lat))];
  const [minLon, maxLon] = [Math.min(...all.map((p) => p.lon)), Math.max(...all.map((p) => p.lon))];
  let zoom = 19;
  while (zoom > 1) {
    const [x0, y0] = worldPixel(maxLat, minLon, zoom);
    const [x1, y1] = worldPixel(minLat, maxLon, zoom);
    if (x1 - x0 <= CARD_W - 60 && y1 - y0 <= CARD_H - 60) break;
    zoom -= 1;
  }
  const [cx0, cy0] = worldPixel(maxLat, minLon, zoom);
  const [cx1, cy1] = worldPixel(minLat, maxLon, zoom);
  const left = (cx0 + cx1) / 2 - CARD_W / 2;
  const top = (cy0 + cy1) / 2 - CARD_H / 2;
  const tiles: { x: number; y: number }[] = [];
  for (let x = Math.floor(left / 256); x <= Math.floor((left + CARD_W) / 256); x++) {
    for (let y = Math.floor(top / 256); y <= Math.floor((top + CARD_H) / 256); y++) tiles.push({ x, y });
  }
  const route = (run: GpsPointDto[]) =>
    run
      .map((p) => {
        const [x, y] = worldPixel(p.lat, p.lon, zoom);
        return `${(x - left).toFixed(1)},${(y - top).toFixed(1)}`;
      })
      .join(' ');
  return (
    <span ref={box} className="relative block">
      <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`} className="block aspect-[8/5] w-full rounded-md bg-surface-2" aria-hidden>
        {seen && tiles.map((t) => (
          <image key={`${t.x}-${t.y}`} href={`https://mt${(t.x + t.y) & 3}.google.com/vt/lyrs=s&x=${t.x}&y=${t.y}&z=${zoom}`} x={t.x * 256 - left} y={t.y * 256 - top} width="257" height="257" />
        ))}
        {runs.map((run) => (
          <g key={run[0].ts} fill="none" strokeLinejoin="round" strokeLinecap="round">
            <polyline points={route(run)} stroke="#000000" strokeOpacity="0.55" strokeWidth="6" />
            <polyline points={route(run)} stroke="#ffd60a" strokeWidth="3" />
          </g>
        ))}
      </svg>
      <span className="absolute right-1 bottom-1 rounded bg-black/55 px-1 text-[11px] text-white">Map data © Google</span>
    </span>
  );
}

/** When a visit was: the day and times, or both days when it runs past midnight. */
function placeWhen(p: Visit): string {
  const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: IST_ZONE });
  const time = (t: number) => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST_ZONE });
  return day(p.from) === day(p.to) ? `${day(p.to)}, ${time(p.from)} – ${time(p.to)}` : `${day(p.from)}, ${time(p.from)} – ${day(p.to)}, ${time(p.to)}`;
}

const placeFacts = (p: Visit) => `${fmtDistance(p.meters)} · ${fmtDuration(p.seconds)} · ${p.runs.length} ${p.runs.length === 1 ? 'run' : 'runs'}`;

function GpsTrack({ points: latest, robotId }: { points: GpsPointDto[]; robotId: string }) {
  // Each minute's refresh returns a new list. The same readings keep the same list, so the map is not redrawn.
  const held = useRef(latest);
  if (held.current.length !== latest.length || held.current[held.current.length - 1]?.ts !== latest[latest.length - 1]?.ts || held.current[0]?.ts !== latest[0]?.ts) held.current = latest;
  const points = held.current;
  /** The visit on the big map: the most recent one until another is clicked, or everything together. */
  const [chosen, setChosen] = useState<string | 'all' | null>(null);
  const { allRuns, visits, placeCount } = useMemo(() => {
    // The server splits the track where GPS was missing or a reading was impossible; a line is drawn only inside a run.
    const bySegment = new Map<number, GpsPointDto[]>();
    for (const p of points) {
      const run = bySegment.get(p.segment);
      if (run) run.push(p);
      else bySegment.set(p.segment, [p]);
    }
    const runs = [...bySegment.values()].filter((x) => x.length > 1);
    return { allRuns: runs, ...groupVisits(runs) };
  }, [points]);
  const place = chosen === 'all' ? null : (visits.find((p) => p.id === chosen) ?? visits[0] ?? null);
  const { lines, markers, dist } = useMemo(() => {
    const runs = place ? place.runs : allRuns;
    const kept = runs.length ? runs.flat() : points;
    const first = kept[0];
    const last = kept[kept.length - 1];
    return {
      lines: runs.map((x) => ({ id: `track-${x[0].segment}`, coordinates: x.map((p) => [p.lon, p.lat]), color: '#ffd60a', width: 3 })),
      markers: [
        { id: 'first', lon: first.lon, lat: first.lat, color: '#16a34a', label: 'First' },
        { id: 'last', lon: last.lon, lat: last.lat, color: '#dc2626', label: 'Latest' },
      ],
      dist: runs.reduce((sum, r) => sum + runMeters(r), 0),
    };
  }, [place, allRuns, points]);
  const bigMap = (
    <>
      <GeoMap lines={lines} points={markers} className="h-[75vh] min-h-[480px]" ariaLabel={`GPS track of ${fmtSerial(robotId)}: ${points.length} points, about ${fmtDistance(dist)}`} />
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-base">
        <span className="font-semibold">About {fmtDistance(dist)}</span>
        <span className="inline-flex items-center gap-1.5 text-muted"><span className="size-3 rounded-full bg-[#16a34a]" aria-hidden /> Start</span>
        <span className="inline-flex items-center gap-1.5 text-muted"><span className="size-3 rounded-full bg-[#dc2626]" aria-hidden /> End</span>
      </p>

    </>
  );
  if (visits.length < 2) return bigMap;
  return (
    <div className="grid gap-3 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2 lg:h-[75vh] lg:min-h-[480px]">
        <div className="flex items-center justify-between gap-2">
          <p className="text-base font-medium">
            {visits.length} visits · {placeCount} {placeCount === 1 ? 'place' : 'places'}
          </p>
          <Button size="sm" onClick={() => setChosen('all')} disabled={!place}>
            Show all
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pr-1">
          {visits.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === place?.id}
              onClick={() => setChosen(p.id)}
              className={cn('w-64 shrink-0 rounded-lg border p-2 text-left transition-colors lg:w-full', p.id === place?.id ? 'border-accent ring-2 ring-accent' : 'border-border hover:border-muted')}
            >
              <PlaceMap runs={p.runs} />
              <span className="mt-1.5 block font-medium">{p.name}</span>
              <span className="block text-sm text-muted">{placeWhen(p)}</span>
              <span className="block text-sm text-muted">{placeFacts(p)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        <p className="mb-2 text-base font-bold">
          {place ? `${place.name} · ${placeWhen(place)} · ${placeFacts(place)}` : 'All places'}
        </p>
        {bigMap}
      </div>
    </div>
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
