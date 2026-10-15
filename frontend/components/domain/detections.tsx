'use client';

/**
 * People the robot's cameras detected (0022; the other detection kinds are kept but not shown), as a
 * snapshot gallery with filters and a full-size viewer (the robot draws its boxes into the snapshot). The same component
 * runs in the admin panel (audience 'staff': false positives on request, source shown) and the client app
 * (audience 'client': confirmed only). Times are IST. Images come through the API, never from the bucket.
 */
import type { DetectionItemDto, DetectionKind, DetectionListDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Clock, Flame, ImageOff, Leaf, MapPin, PawPrint, User, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, Pagination, type Tone } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

export type DetectionAudience = 'staff' | 'client';

const IST = 'Asia/Kolkata';
const PAGE_SIZE = 24;
/** Only people are shown (user decision, 2026-10-15); wildlife, fire / smoke and vegetation stay in the index. */
const SHOWN_KIND: DetectionKind = 'human';

const KIND_META: Record<DetectionKind, { label: string; plural: string; icon: typeof User; tone: Tone; color: string }> = {
  human: { label: 'Person', plural: 'People', icon: User, tone: 'fault', color: '#ff453a' },
  wildlife: { label: 'Wildlife', plural: 'Wildlife', icon: PawPrint, tone: 'warn', color: '#ff9f0a' },
  fire: { label: 'Fire / smoke', plural: 'Fire & smoke', icon: Flame, tone: 'fault', color: '#ff375f' },
  vegetation: { label: 'Vegetation', plural: 'Vegetation', icon: Leaf, tone: 'ok', color: '#30d158' },
};

const PERIODS = [
  { id: 'all', label: 'All time' },
  { id: '1d', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom dates…' },
] as const;
type PeriodId = (typeof PERIODS)[number]['id'];

const istDay = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString('en-CA', { timeZone: IST });
/** IST calendar day → the instant it starts. */
const dayStart = (d: string) => new Date(`${d}T00:00:00+05:30`).toISOString();
const dayAfter = (d: string) => new Date(new Date(`${d}T00:00:00+05:30`).getTime() + 86_400_000).toISOString();

function periodRange(id: PeriodId, from: string, to: string): { from?: string; to?: string } {
  const now = Date.now();
  if (id === '1d') return { from: new Date(now - 86_400_000).toISOString() };
  if (id === '7d') return { from: new Date(now - 7 * 86_400_000).toISOString() };
  if (id === '30d') return { from: new Date(now - 30 * 86_400_000).toISOString() };
  if (id === 'custom') return { from: from ? dayStart(from) : undefined, to: to ? dayAfter(to) : undefined };
  return {};
}

const fmtIst = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('en-IN', { timeZone: IST, ...opts });
const fmtWhen = (iso: string) => fmtIst(iso, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtShort = (iso: string) => fmtIst(iso, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDay = (iso: string) => fmtIst(iso, { day: '2-digit', month: 'short', year: 'numeric' });
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);
const camLabel = (c: string) => c.replace(/^cam(\d+)$/, 'Camera $1');
const title = (d: DetectionItemDto) => (d.kind === 'human' ? (d.count > 1 ? `${d.count} people` : 'Person') : d.label ? d.label[0].toUpperCase() + d.label.slice(1) : KIND_META[d.kind].label);

export function DetectionsTab({ robotId, audience }: { robotId: string; audience: DetectionAudience }) {
  const [period, setPeriod] = useState<PeriodId>('all');
  const [from, setFrom] = useState(istDay(6));
  const [to, setTo] = useState(istDay());
  const [camera, setCamera] = useState('');
  const [status, setStatus] = useState<'confirmed' | 'rejected' | 'all'>('confirmed');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const range = periodRange(period, from, to);
  const path = audience === 'client' ? `/robots/${robotId}/client/detections` : `/robots/${robotId}/detections`;

  // Any filter change starts again on page 1.
  useEffect(() => setPage(1), [period, from, to, camera, status]);

  const q = useQuery({
    queryKey: ['robot', robotId, 'detections', audience, range.from, range.to, camera, status, page],
    queryFn: () =>
      api.get<DetectionListDto>(path, { ...range, kind: SHOWN_KIND, camera: camera || undefined, status: audience === 'staff' ? status : undefined, page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
    enabled: period !== 'custom' || (!!from && !!to && from <= to),
  });
  const data = q.data;
  const people = data?.total ?? 0;
  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <Users className="size-4" aria-hidden /> People detected
          </span>
        }
        actions={data?.available && <span className="text-xs text-muted">Data from {fmtDay(data.available.first)} to {fmtDay(data.available.last)} · times IST</span>}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Period" className="w-full sm:w-48">
            <Select value={period} onChange={(e) => setPeriod(e.target.value as PeriodId)}>
              {PERIODS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          {period === 'custom' && (
            <>
              <Field label="From" className="w-[calc(50%-0.375rem)] sm:w-40">
                <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To" className="w-[calc(50%-0.375rem)] sm:w-40">
                <Input type="date" value={to} min={from || undefined} max={istDay()} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Camera" className="w-full sm:w-40">
            <Select value={camera} onChange={(e) => setCamera(e.target.value)}>
              <option value="">All cameras</option>
              {(data?.cameras ?? []).map((c) => (
                <option key={c} value={c}>
                  {camLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
          {audience === 'staff' && (
            <Field label="Review" className="w-full sm:w-48">
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="confirmed">Confirmed</option>
                <option value="rejected">False positives</option>
                <option value="all">All</option>
              </Select>
            </Field>
          )}
        </div>

        {data && (
          <p className="mt-4 text-sm text-muted" aria-live="polite">
            <span className="font-semibold text-fg tabular-nums">{people.toLocaleString('en-IN')}</span> {people === 1 ? 'detection' : 'detections'} of people in this period
          </p>
        )}
      </Card>

      {q.isLoading ? (
        <LoadingBlock rows={6} label="Loading detections" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !items.length ? (
        <EmptyState
          icon={<Users className="size-8" />}
          title="No people detected"
          description={
            data?.available
              ? `Nothing matches these filters. This robot has people detections from ${fmtDay(data.available.first)} to ${fmtDay(data.available.last)}.`
              : 'This robot has not reported any people detections yet.'
          }
          action={
            data?.available && (period !== 'all' || camera) ? (
              <Button
                size="sm"
                onClick={() => {
                  setPeriod('all');
                  setCamera('');
                }}
              >
                Show all detections
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4', q.isPlaceholderData && 'opacity-60')}>
            {items.map((d, i) => (
              <li key={d.id}>
                <DetectionCard d={d} onOpen={() => setOpen(i)} />
              </li>
            ))}
          </ul>
          {data && data.total > PAGE_SIZE && <Pagination page={page} limit={PAGE_SIZE} total={data.total} onPage={setPage} />}
        </>
      )}

      {open !== null && items[open] && (
        <DetectionViewer
          d={items[open]}
          audience={audience}
          position={`${(page - 1) * PAGE_SIZE + open + 1} of ${data?.total ?? items.length}`}
          onClose={() => setOpen(null)}
          onPrev={open > 0 ? () => setOpen(open - 1) : undefined}
          onNext={open < items.length - 1 ? () => setOpen(open + 1) : undefined}
        />
      )}
    </div>
  );
}

function DetectionCard({ d, onOpen }: { d: DetectionItemDto; onOpen: () => void }) {
  const M = KIND_META[d.kind];
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface text-left transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      aria-label={`${title(d)} on ${camLabel(d.camera)}, ${fmtWhen(d.detected_at)} IST. Open`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-2">
        {d.image_url && !failed ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated API image, not a static asset
          <img src={d.image_url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1 text-xs text-muted">
            <ImageOff className="size-6" aria-hidden />
            No snapshot
          </span>
        )}
        <span className="absolute top-2 left-2">
          <Badge tone={M.tone} icon={<M.icon className="size-3.5" aria-hidden />} className="shadow-sm backdrop-blur">
            {title(d)}
          </Badge>
        </span>
        {d.status === 'rejected' && (
          <span className="absolute top-2 right-2">
            <Badge tone="neutral">False positive</Badge>
          </span>
        )}
        <span className="absolute right-2 bottom-2 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold text-white">{camLabel(d.camera)}</span>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="inline-flex items-center gap-1 tabular-nums text-fg" title={d.time_estimated ? 'Approximate time: the robot clock was not synced' : undefined}>
          <Clock className="size-3.5 text-muted" aria-hidden />
          {d.time_estimated && '≈ '}
          {fmtShort(d.detected_at)}
        </span>
        <span className="text-muted tabular-nums">{d.confidence !== null ? `${Math.round(d.confidence * 100)} % sure` : ''}</span>
      </div>
    </button>
  );
}

function DetectionViewer({
  d,
  audience,
  position,
  onClose,
  onPrev,
  onNext,
}: {
  d: DetectionItemDto;
  audience: DetectionAudience;
  position: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const M = KIND_META[d.kind];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && onPrev) onPrev();
      if (e.key === 'ArrowRight' && onNext) onNext();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onPrev, onNext]);

  const seen = d.labels ? Object.entries(d.labels).sort((a, b) => b[1] - a[1]) : [];
  const facts: [string, ReactNode][] = [
    ['When (IST)', <>{d.time_estimated && <span title="The robot clock was not synced on this run">≈ </span>}{fmtWhen(d.detected_at)}</>],
    ['Camera', camLabel(d.camera)],
    ['Type', M.label],
    [d.kind === 'human' ? 'People' : 'Objects', String(d.count)],
    ['Confidence', pct(d.confidence)],
    ...(seen.length > 1 ? ([['Also seen', seen.map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join(', ')]] as [string, ReactNode][]) : []),
    ...(d.mission_name || d.mission_id ? ([['Mission', d.mission_name ?? d.mission_id]] as [string, ReactNode][]) : []),
    ...(d.lat !== null && d.lon !== null
      ? ([
          [
            'Position',
            <a key="pos" href={`https://www.google.com/maps?q=${d.lat},${d.lon}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline">
              <MapPin className="size-3.5" aria-hidden />
              {d.lat.toFixed(5)}, {d.lon.toFixed(5)}
            </a>,
          ],
        ] as [string, ReactNode][])
      : []),
    ...(audience === 'staff' ? ([['Review', d.status === 'rejected' ? 'False positive' : 'Confirmed'], ['Source', <span key="src" className="font-mono text-xs break-all">{d.source}</span>]] as [string, ReactNode][]) : []),
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={
        <span className="inline-flex items-center gap-2">
          <M.icon className="size-5" aria-hidden style={{ color: M.color }} />
          {title(d)}
        </span>
      }
      description={`${camLabel(d.camera)} · ${fmtWhen(d.detected_at)} IST · ${position}`}
      footer={
        <>
          <Button onClick={onPrev} disabled={!onPrev} icon={<ChevronLeft className="size-4" aria-hidden />}>
            Newer
          </Button>
          <Button onClick={onNext} disabled={!onNext}>
            Older <ChevronRight className="size-4" aria-hidden />
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="relative overflow-hidden rounded-md bg-black">
          {d.image_url ? (
            // The robot draws the detector's boxes and labels into the snapshot itself.
            // eslint-disable-next-line @next/next/no-img-element -- authenticated API image
            <img key={d.id} src={d.image_url} alt={`${title(d)} seen by ${camLabel(d.camera)}`} className="block h-auto max-h-[65vh] w-full object-contain" />
          ) : (
            <span className="flex aspect-[4/3] flex-col items-center justify-center gap-2 text-sm text-white/70">
              <ImageOff className="size-8" aria-hidden />
              No snapshot was saved for this detection
            </span>
          )}
        </div>
        <dl className="flex flex-col gap-3 text-sm">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
              <dd className="mt-0.5 break-words">{value}</dd>
            </div>
          ))}
          {d.image_url && (
            <a href={d.image_url} target="_blank" rel="noreferrer" className="mt-1 text-sm font-medium text-accent-text hover:underline">
              Open full-size image ↗
            </a>
          )}
        </dl>
      </div>
    </Dialog>
  );
}
