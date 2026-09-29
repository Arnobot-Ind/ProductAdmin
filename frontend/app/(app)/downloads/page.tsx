'use client';

import type { ArchiveSessionDto, ArchiveSessionListDto, Paginated, RobotListItemDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { Activity, Check, Download, FileJson, Gauge, Info, Radar, Satellite, Video } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { EmptyState, InlineAlert, LoadingBlock, ErrorState, PageHeader, Time } from '@/components/ui/misc';
import { api, downloadUrl } from '@/lib/api';
import { useCanAnywhere } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtBytes, fmtDuration, fromLocalInput } from '@/lib/format';
import { useDocumentTitle } from '@/lib/hooks';

type TypeKey = 'video' | 'imu' | 'gps' | 'lidar' | 'encoder' | 'meta';
const TYPES: { key: TypeKey; label: string; detail: string; Icon: typeof Video; sensor: boolean }[] = [
  { key: 'video', label: 'Video', detail: 'Camera feeds (.ts)', Icon: Video, sensor: false },
  { key: 'imu', label: 'IMU', detail: 'Accel, gyro, attitude (.csv.gz)', Icon: Activity, sensor: true },
  { key: 'gps', label: 'GPS', detail: 'RTK fixes (.csv.gz)', Icon: Satellite, sensor: true },
  { key: 'lidar', label: 'LiDAR', detail: 'Scans (.npz)', Icon: Radar, sensor: true },
  { key: 'encoder', label: 'Encoders', detail: 'Wheel rpm, odometry (.csv.gz)', Icon: Gauge, sensor: true },
  { key: 'meta', label: 'Metadata', detail: 'session.json, upload log', Icon: FileJson, sensor: false },
];
const PERIODS = [
  { id: '1d', label: 'Last 24 h', ms: 86_400_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { id: 'all', label: 'All time', ms: 0 },
  { id: 'custom', label: 'Custom', ms: 0 },
] as const;
const MAX_RECORDINGS = 200;
const LARGE_BYTES = 5 * 1024 ** 3;

function sizeOf(s: ArchiveSessionDto, t: TypeKey): number {
  if (t === 'video') return s.bytes.camera;
  if (t === 'meta') return s.bytes.meta;
  return s.sensor_bytes[t];
}

/** Data dump: any robot's recordings, any mix of data types, as one zip straight from the archive bucket. */
export default function DownloadsPage() {
  useDocumentTitle('Data export');
  const canAnywhere = useCanAnywhere();
  const restricted = canAnywhere('data.download_restricted');
  const types = TYPES.filter((t) => !t.sensor || restricted);

  const robots = useQuery({ queryKey: ['robots', 'options'], queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { limit: 200 }), staleTime: 60_000 });
  const params = useSearchParams();
  const [robot, setRobot] = useState(params.get('robot') ?? '');
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['id']>('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sim, setSim] = useState(false);
  const [picked, setPicked] = useState<Set<TypeKey>>(new Set(types.map((t) => t.key)));
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // First robot with recordings by default.
  useEffect(() => {
    if (!robot && robots.data?.items.length) setRobot((robots.data.items.find((r) => r.video_sessions > 0) ?? robots.data.items[0]).robot_id);
  }, [robots.data, robot]);

  const sessions = useQuery({
    queryKey: ['archive', 'sessions', 'downloads', robot, sim],
    queryFn: () => api.get<ArchiveSessionListDto>('/archive/sessions', { robot, include_sim: sim, limit: 200 }),
    enabled: !!robot,
  });

  const rows = useMemo(() => {
    const all = sessions.data?.items ?? [];
    const p = PERIODS.find((x) => x.id === period)!;
    const lo = period === 'custom' ? (from ? Date.parse(fromLocalInput(from) ?? '') : -Infinity) : p.ms ? Date.now() - p.ms : -Infinity;
    const hi = period === 'custom' && to ? Date.parse(fromLocalInput(to) ?? '') : Infinity;
    return all.filter((s) => {
      const t = s.started_at ? Date.parse(s.started_at) : NaN;
      return Number.isNaN(t) ? period === 'all' : t >= lo && t <= hi;
    });
  }, [sessions.data, period, from, to]);

  // A new list selects everything in it.
  useEffect(() => setSelected(new Set(rows.map((s) => s.id))), [rows]);

  const chosen = rows.filter((s) => selected.has(s.id));
  const typeTotals = Object.fromEntries(types.map((t) => [t.key, chosen.reduce((n, s) => n + sizeOf(s, t.key), 0)])) as Record<TypeKey, number>;
  const total = [...picked].reduce((n, t) => n + (typeTotals[t] ?? 0), 0);
  const tooMany = chosen.length > MAX_RECORDINGS;
  const href =
    chosen.length && picked.size && !tooMany
      ? downloadUrl(`/archive/download.zip?sessions=${chosen.map((s) => s.id).join(',')}&include=${[...picked].join(',')}`)
      : null;
  const toggleType = (k: TypeKey) => setPicked((p) => (p.has(k) ? new Set([...p].filter((x) => x !== k)) : new Set([...p, k])));
  const toggleRow = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  if (!canAnywhere('data.download')) {
    return (
      <>
        <PageHeader title="Data export" />
        <InlineAlert tone="fault">Your role can view recordings but not download them.</InlineAlert>
      </>
    );
  }

  return (
    <div className="pb-24">
      <PageHeader
        eyebrow="Fleet"
        title="Data export"
        description="Choose a robot, the recordings and the data you need, and download it as one zip file."
      />

      <section aria-label="What to download" className="grid gap-4 rounded-lg border border-border bg-surface p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="grid gap-3">
          <Field label="Robot">
            <Select value={robot} onChange={(e) => setRobot(e.target.value)}>
              {robots.data?.items.map((r) => (
                <option key={r.robot_id} value={r.robot_id}>
                  {r.robot_id} · {r.product_name} · {r.video_sessions} recording{r.video_sessions === 1 ? '' : 's'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Period">
            <Select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}>
              {PERIODS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          {period === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="From">
                <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>
          )}
          <Checkbox label="Include bench simulations" checked={sim} onChange={(e) => setSim(e.target.checked)} />
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium">Include</legend>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {types.map((t) => {
              const on = picked.has(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleType(t.key)}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                    on ? 'border-accent bg-accent-soft/60' : 'border-border hover:bg-surface-2',
                  )}
                >
                  <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', on ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted')} aria-hidden>
                    <t.Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{t.label}</span>
                    <span className="block truncate text-xs text-muted">{t.detail}</span>
                  </span>
                  <span className="text-right">
                    <span className="block text-xs font-medium tabular-nums">{fmtBytes(typeTotals[t.key])}</span>
                    {on && <Check className="ml-auto size-4 text-accent-text" aria-hidden />}
                  </span>
                </button>
              );
            })}
          </div>
          {!restricted && <p className="mt-2 text-xs text-muted">LiDAR, IMU, GPS and encoder data are not available for your role.</p>}
        </fieldset>
      </section>

      <section aria-label="Recordings" className="mt-5">
        {robots.isLoading || sessions.isLoading ? (
          <LoadingBlock rows={6} label="Loading recordings" />
        ) : sessions.error ? (
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
        ) : !rows.length ? (
          <EmptyState icon={<Video className="size-8" />} title="No recordings in this period" description="Pick a longer period or another robot." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Recordings to download</caption>
              <thead className="bg-surface-2 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                <tr>
                  <th scope="col" className="w-10 px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all recordings"
                      checked={selected.size === rows.length}
                      ref={(el) => {
                        if (el) el.indeterminate = selected.size > 0 && selected.size < rows.length;
                      }}
                      onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((s) => s.id)) : new Set())}
                    />
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Recording
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Started
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    Duration
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Contains
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    Size (selected types)
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const on = selected.has(s.id);
                  const size = [...picked].reduce((n, t) => n + sizeOf(s, t), 0);
                  return (
                    <tr key={s.id} className={cn('cursor-pointer border-t border-border', on ? 'bg-accent-soft/30' : 'hover:bg-surface-2')} onClick={() => toggleRow(s.id)}>
                      <td className="px-4 py-2.5">
                        <input type="checkbox" checked={on} onChange={() => toggleRow(s.id)} onClick={(e) => e.stopPropagation()} aria-label={`Select ${s.session_id}`} />
                      </td>
                      <th scope="row" className="px-2 py-2.5 text-left font-normal">
                        <Link href={`/videos/${s.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-sm font-medium text-accent-text hover:underline">
                          {s.session_id}
                        </Link>
                        {s.trip && <span className="block text-xs text-muted">{s.trip}</span>}
                      </th>
                      <td className="px-2 py-2.5">
                        <Time iso={s.started_at} />
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{fmtDuration(s.duration_s)}</td>
                      <td className="px-2 py-2.5">
                        <span className="flex flex-wrap gap-1">
                          {s.cameras.length > 0 && <Chip>{s.cameras.length} cam</Chip>}
                          {s.has_imu && <Chip>IMU</Chip>}
                          {s.has_gps && <Chip>GPS</Chip>}
                          {s.has_lidar && <Chip>LiDAR</Chip>}
                          {s.has_encoder && <Chip>Enc</Chip>}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{fmtBytes(size)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Sticky summary: what one click will download. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 backdrop-blur lg:left-60">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <p className="text-sm">
            <span className="font-semibold">{chosen.length}</span> recording{chosen.length === 1 ? '' : 's'} ·{' '}
            {picked.size ? [...picked].map((k) => TYPES.find((t) => t.key === k)!.label).join(', ') : 'nothing selected'} ·{' '}
            <span className="font-semibold tabular-nums">{fmtBytes(total)}</span>
          </p>
          {total > LARGE_BYTES && (
            <span className="inline-flex items-center gap-1 text-xs text-warn">
              <Info className="size-3.5" aria-hidden /> Large download: keep this tab open until it finishes.
            </span>
          )}
          {tooMany && <span className="text-xs text-fault">At most {MAX_RECORDINGS} recordings per zip.</span>}
          <span className="ml-auto" />
          {href ? (
            <a href={href} className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-5 text-sm font-semibold text-accent-fg hover:opacity-90">
              <Download className="size-4" aria-hidden /> Download .zip
            </a>
          ) : (
            <span className="inline-flex h-10 cursor-not-allowed items-center gap-2 rounded-md bg-accent px-5 text-sm font-semibold text-accent-fg opacity-50" aria-disabled>
              <Download className="size-4" aria-hidden /> Download .zip
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium">{children}</span>;
}
