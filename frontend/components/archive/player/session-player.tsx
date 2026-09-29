'use client';

import type { ArchiveCameraDto } from '@arnobot/message-schema';
import { Columns2, Grid2x2, Maximize, Minimize, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { CameraView } from './camera-view';
import { Timeline, type Lane } from './timeline';
import { useClock } from './use-clock';

type Layout = 'grid' | 'focus' | 'single';

function coverage(items: ArchiveCameraDto['segments']): [number, number][] {
  const out: [number, number][] = [];
  for (const it of items) {
    const a = it.start_ms;
    const b = it.start_ms + it.duration_s * 1000;
    const last = out[out.length - 1];
    if (last && a - last[1] < 2000) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The session's cameras as one continuous video each, kept in sync on one timeline. */
export function SessionPlayer({ start, end, cameras, initialTime }: { start: number; end: number; cameras: ArchiveCameraDto[]; initialTime?: number }) {
  const firstFrame = Math.min(...cameras.flatMap((c) => c.segments.map((s) => s.start_ms)));
  const clock = useClock(start, end, initialTime ?? (Number.isFinite(firstFrame) ? firstFrame : start));
  const consoleRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<Layout>('grid');
  const [selected, setSelected] = useState(cameras[0]?.name ?? '');
  const [fullscreen, setFullscreen] = useState(false);
  const lanes: Lane[] = useMemo(() => cameras.map((c) => ({ label: c.name, ranges: coverage(c.segments) })), [cameras]);
  const multi = cameras.length > 1;
  const effective: Layout = multi ? layout : 'single';

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else consoleRef.current?.requestFullscreen().catch(() => undefined);
  };

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === consoleRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // 1-9 one camera, G grid, V focus, F fullscreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return;
      const n = Number(e.key);
      if (n >= 1 && n <= cameras.length) {
        setSelected(cameras[n - 1].name);
        setLayout((l) => (l === 'grid' ? 'single' : l));
      } else if (e.key === 'g' || e.key === '0') setLayout('grid');
      else if (e.key === 'v') setLayout('focus');
      else if (e.key === 'f') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cameras]);

  // Tiles keep one parent and a stable key across layouts, so switching never reloads a stream.
  const cols = cameras.length <= 1 ? 1 : cameras.length <= 4 ? 2 : 3;
  const others = cameras.filter((c) => c.name !== selected);
  const wallStyle: CSSProperties =
    effective === 'focus'
      ? { gridTemplateColumns: '3fr 1fr', gridTemplateRows: `repeat(${Math.max(1, others.length)}, minmax(0, 1fr))` }
      : effective === 'grid'
        ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
        : {};
  const fit =
    effective === 'focus'
      ? fullscreen
        ? 'max-w-[calc((100dvh-10rem)*64/27)]'
        : 'lg:max-w-[calc((100dvh-22rem)*64/27)]'
      : fullscreen
        ? 'max-w-[calc((100dvh-10rem)*16/9)]'
        : 'lg:max-w-[calc((100dvh-22rem)*16/9)]';

  return (
    <section ref={consoleRef} aria-label="Camera player" className={cn('overflow-hidden border border-border bg-[#0c0d10] text-white', fullscreen ? 'flex h-full flex-col' : 'rounded-lg')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-white/80 uppercase">Cameras</h2>
        <span className="text-xs text-white/45">
          {cameras.length} camera{cameras.length === 1 ? '' : 's'} in sync
        </span>
        <div className="ml-auto flex items-center gap-2">
          {multi && (
            <>
              <div className="flex rounded border border-white/15" role="group" aria-label="Layout">
                <Seg active={layout === 'grid'} onClick={() => setLayout('grid')} title="All cameras (G)" icon={<Grid2x2 className="size-3.5" aria-hidden />} label="Grid" />
                <Seg active={layout === 'focus'} onClick={() => setLayout('focus')} title="One large, the rest beside it (V)" icon={<Columns2 className="size-3.5" aria-hidden />} label="Focus" />
                <Seg active={layout === 'single'} onClick={() => setLayout('single')} title="One camera (1–9)" icon={<Square className="size-3.5" aria-hidden />} label="Single" />
              </div>
              {effective !== 'grid' && (
                <div className="hidden items-center gap-1 sm:flex">
                  {cameras.map((c, i) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => setSelected(c.name)}
                      title={`Show ${c.name} (${i + 1})`}
                      aria-pressed={c.name === selected}
                      className={cn('rounded px-2 py-1 font-mono text-[11px]', c.name === selected ? 'bg-white/15 text-white' : 'text-white/55 hover:bg-white/5 hover:text-white')}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen wall (F)'}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen camera wall'}
            className="grid size-7 place-items-center rounded text-white/70 hover:bg-white/10 hover:text-white"
          >
            {fullscreen ? <Minimize className="size-4" aria-hidden /> : <Maximize className="size-4" aria-hidden />}
          </button>
        </div>
      </div>

      <div className={cn('bg-black', fullscreen && 'grid min-h-0 flex-1 place-items-center')}>
        {cameras.length === 0 ? (
          <div className="grid aspect-video place-items-center text-sm text-white/55">No camera video in this recording</div>
        ) : (
          <div className={cn('mx-auto grid w-full gap-px bg-white/10', fit)} style={wallStyle}>
            {cameras.map((c, i) => {
              const isSel = c.name === selected;
              const main = effective === 'focus' && isSel;
              const place: CSSProperties = effective === 'focus' ? (main ? { gridColumn: 1, gridRow: '1 / -1' } : { gridColumn: 2, gridRow: others.indexOf(c) + 1 }) : {};
              return (
                <CameraView
                  key={c.name}
                  camera={c.name}
                  index={i}
                  segments={c.segments}
                  playlistUrl={c.playlist_url}
                  time={clock.time}
                  playing={clock.playing}
                  rate={clock.rate}
                  hidden={effective === 'single' && !isSel}
                  compact={effective === 'focus' && !main}
                  fill={main}
                  style={place}
                  onSelect={
                    multi
                      ? () => {
                          if (effective === 'focus') setSelected(c.name);
                          else if (effective === 'grid') {
                            setSelected(c.name);
                            setLayout('single');
                          } else setLayout('grid');
                        }
                      : undefined
                  }
                  selectHint={effective === 'single' ? 'Back to all cameras' : effective === 'focus' ? 'Make this the large view' : 'Show only this camera'}
                />
              );
            })}
          </div>
        )}
      </div>

      <Timeline clock={clock} start={start} end={end} lanes={lanes} />
    </section>
  );
}

function Seg({ active, onClick, title, icon, label }: { active: boolean; onClick: () => void; title: string; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn('flex items-center gap-1.5 px-2 py-1 text-xs first:rounded-l last:rounded-r', active ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white')}
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}
