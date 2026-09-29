'use client';

import type { ArchiveStreamDto, LidarPreviewDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CloudOff, FileWarning, Pause, Play, Radar } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { StreamPlaceholder } from './stream-placeholder';

const chunkLabel = (name: string) => name.split('/').pop() ?? name;

/**
 * LiDAR of one recording, as seen from above: the robot in the middle, front up, one scan at a time.
 * Scans come from the server-side preview (a few per chunk, down-sampled); the raw .npz stays restricted.
 */
export function LidarView({ sessionId, stream }: { sessionId: string; stream: ArchiveStreamDto }) {
  const [chunk, setChunk] = useState<string | null>(null);
  const [scan, setScan] = useState(0);
  const [playing, setPlaying] = useState(false);
  const q = useQuery({
    queryKey: ['archive', 'session', sessionId, 'lidar', chunk],
    queryFn: () => api.get<LidarPreviewDto>(`/archive/sessions/${sessionId}/sensors/lidar`, { chunk: chunk ?? undefined }),
    enabled: stream.available,
    staleTime: 300_000,
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const scans = d?.scans ?? [];

  useEffect(() => setScan(0), [d?.chunk]);
  useEffect(() => {
    if (!playing || scans.length < 2) return;
    const t = window.setInterval(() => setScan((s) => (s + 1) % scans.length), 250);
    return () => window.clearInterval(t);
  }, [playing, scans.length]);

  if (!stream.available) {
    return (
      <StreamPlaceholder icon={<Radar className="size-8" />} title="No LiDAR data">
        {stream.reason}
      </StreamPlaceholder>
    );
  }
  if (q.isLoading) {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading LiDAR data…</span>
        <Skeleton className="aspect-square max-h-[28rem] w-full" />
      </div>
    );
  }
  if (q.error || !d) {
    return (
      <StreamPlaceholder icon={<CloudOff className="size-8" />} title="Could not load the LiDAR preview" tone="fault" action={<Button size="sm" onClick={() => void q.refetch()}>Try again</Button>}>
        {errorMessage(q.error)}
      </StreamPlaceholder>
    );
  }

  const picker = d.chunks.length > 1 && (
    <Select aria-label="LiDAR chunk" value={d.chunk ?? ''} onChange={(e) => setChunk(e.target.value)} className="h-8 w-56 text-xs" disabled={q.isFetching}>
      {d.chunks.map((c) => (
        <option key={c} value={c}>
          {chunkLabel(c)}
        </option>
      ))}
    </Select>
  );

  if (d.status === 'unavailable') {
    const storage = d.problem === 'storage_unavailable';
    return (
      <div className="flex flex-col gap-3">
        {picker && <div className="flex justify-end">{picker}</div>}
        <StreamPlaceholder
          icon={storage ? <CloudOff className="size-8" /> : <FileWarning className="size-8" />}
          title={storage ? 'LiDAR storage unreachable' : d.problem === 'too_large' ? 'Chunk too large to preview' : d.problem === 'missing' ? 'LiDAR chunk missing' : 'LiDAR data could not be decoded'}
          tone={storage ? 'fault' : 'warn'}
          action={storage ? <Button size="sm" onClick={() => void q.refetch()}>Try again</Button> : undefined}
        >
          {d.message}
          {d.chunks.length > 1 && !storage && ' Other chunks may still be readable.'}
        </StreamPlaceholder>
      </div>
    );
  }

  const current = scans[Math.min(scan, scans.length - 1)];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {picker}
        <Button
          size="sm"
          icon={playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
          onClick={() => setPlaying((p) => !p)}
          disabled={scans.length < 2}
          aria-pressed={playing}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <label className="flex min-w-48 flex-1 items-center gap-2 text-xs text-muted">
          <span className="whitespace-nowrap">
            Scan {scans.length ? Math.min(scan, scans.length - 1) + 1 : 0}/{scans.length}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, scans.length - 1)}
            value={Math.min(scan, scans.length - 1)}
            onChange={(e) => {
              setPlaying(false);
              setScan(Number(e.target.value));
            }}
            className="flex-1 accent-[var(--accent)]"
            aria-label="Scan"
          />
        </label>
      </div>
      {current && current.points.length ? (
        <LidarCanvas points={current.points} maxRange={d.max_range_m} label={`LiDAR scan at ${fmtDateTime(new Date(current.t_ms).toISOString())}: ${current.points.length} points, farthest ${d.max_range_m} m`} />
      ) : (
        <StreamPlaceholder icon={<Radar className="size-8" />} title="Empty scan">
          This scan has no returns (nothing within range).
        </StreamPlaceholder>
      )}
      <p className="text-xs text-muted">
        {current && <>{fmtDateTime(new Date(current.t_ms).toISOString())} · </>}
        {chunkLabel(d.chunk ?? '')}: {d.scans_total.toLocaleString()} scans, {d.points_total.toLocaleString()} points; {scans.length} scans shown, front of the robot is up, rings every{' '}
        {ringStep(d.max_range_m)} m.
      </p>
    </div>
  );
}

function ringStep(max: number): number {
  if (max <= 2) return 0.5;
  if (max <= 6) return 1;
  if (max <= 15) return 2;
  return 5;
}

function LidarCanvas({ points, maxRange, label }: { points: [number, number][]; maxRange: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const size = canvas.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const css = getComputedStyle(document.documentElement);
      const color = (v: string, fallback: string) => css.getPropertyValue(v).trim() || fallback;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const c = size / 2;
      const range = Math.max(0.5, maxRange) * 1.05;
      const scale = (size / 2 - 8) / range;

      // range rings + labels
      const step = ringStep(maxRange);
      ctx.strokeStyle = color('--border', '#ccc');
      ctx.fillStyle = color('--text-muted', '#888');
      ctx.font = '10px system-ui, sans-serif';
      ctx.lineWidth = 1;
      for (let r = step; r <= range; r += step) {
        ctx.beginPath();
        ctx.arc(c, c, r * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillText(`${r} m`, c + 3, c - r * scale + 11);
      }
      ctx.beginPath();
      ctx.moveTo(c, 4);
      ctx.lineTo(c, size - 4);
      ctx.moveTo(4, c);
      ctx.lineTo(size - 4, c);
      ctx.stroke();

      // points: angle 0 = front (up), clockwise
      ctx.fillStyle = color('--accent', '#38559d');
      for (const [angle, r] of points) {
        const a = (angle * Math.PI) / 180;
        const x = c + Math.sin(a) * r * scale;
        const y = c - Math.cos(a) * r * scale;
        ctx.fillRect(x - 1.25, y - 1.25, 2.5, 2.5);
      }

      // robot, pointing forward
      ctx.fillStyle = color('--warn', '#d97706');
      ctx.beginPath();
      ctx.moveTo(c, c - 9);
      ctx.lineTo(c - 6, c + 6);
      ctx.lineTo(c + 6, c + 6);
      ctx.closePath();
      ctx.fill();
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    // Redraw when the theme (and so the CSS colors) changes.
    const mo = new MutationObserver(draw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [points, maxRange]);
  return <canvas ref={ref} role="img" aria-label={label} className="aspect-square max-h-[28rem] w-full max-w-[28rem] self-center rounded-md border border-border bg-surface-2/40" />;
}
