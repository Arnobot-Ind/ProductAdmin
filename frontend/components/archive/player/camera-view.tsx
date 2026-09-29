'use client';

import type Hls from 'hls.js';
import { Camera, Maximize } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { fmtChunkTime } from './use-clock';

export interface Segment {
  start_ms: number;
  duration_s: number;
}

interface Props {
  camera: string;
  index: number;
  segments: Segment[];
  playlistUrl: string;
  time: number;
  playing: boolean;
  rate: number;
  /** kept mounted (the stream stays loaded) but not shown */
  hidden?: boolean;
  /** small thumbnail tile: fewer overlays */
  compact?: boolean;
  /** fill the grid cell instead of keeping 16:9 */
  fill?: boolean;
  style?: CSSProperties;
  onSelect?: () => void;
  selectHint?: string;
}

/** Wall-clock ms → position in the concatenated HLS timeline, or null inside a recording gap. */
function mediaTimeAt(segments: Segment[], t: number): number | null {
  let offset = 0;
  for (const s of segments) {
    if (t >= s.start_ms && t < s.start_ms + s.duration_s * 1000) return offset + (t - s.start_ms) / 1000;
    offset += s.duration_s;
  }
  return null;
}

/** One camera tile: an HLS stream that follows the shared session clock. */
export function CameraView({ camera, index, segments, playlistUrl, time, playing, rate, hidden, compact, fill, style, onSelect, selectHint }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const media = mediaTimeAt(segments, time);

  // A recording session keeps adding segments. Reload the playlist only while paused, so the live
  // refresh never interrupts playback.
  const [loadedCount, setLoadedCount] = useState(segments.length);
  if (!playing && loadedCount !== segments.length) setLoadedCount(segments.length);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !loadedCount) return;
    const src = `${playlistUrl}?n=${loadedCount}`;
    let hls: Hls | null = null;
    let cancelled = false;
    void (async () => {
      const { default: HlsLib } = await import('hls.js');
      if (cancelled) return;
      if (HlsLib.isSupported()) {
        hls = new HlsLib({ maxBufferLength: 20, backBufferLength: 30 });
        hls.on(HlsLib.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          setError(
            data.details === 'bufferAddCodecError' || data.details === 'manifestIncompatibleCodecsError'
              ? "This browser can't decode the camera codec (H.265?). Try Safari or Edge, or download the MP4 below."
              : `Playback error: ${data.details}`,
          );
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src; // Safari plays HLS natively
      } else {
        setError("HLS playback isn't supported in this browser.");
      }
    })();
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [playlistUrl, loadedCount]);

  // follow the session clock
  useEffect(() => {
    const video = videoRef.current;
    if (!video || error) return;
    if (media === null) {
      if (!video.paused) video.pause();
      return;
    }
    video.playbackRate = rate;
    const drift = Math.abs(video.currentTime - media);
    if (playing) {
      if (drift > 0.75) video.currentTime = media;
      if (video.paused) video.play().catch(() => undefined);
    } else {
      if (!video.paused) video.pause();
      if (drift > 0.05) video.currentTime = media;
    }
  }, [media, playing, rate, error]);

  function snapshot() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${camera}_${fmtChunkTime(time)}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }, 'image/png');
  }

  function fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else boxRef.current?.requestFullscreen().catch(() => undefined);
  }

  const canPlay = !error && media !== null;
  const noSignal = !segments.length || media === null;
  const tool =
    'pointer-events-auto grid size-7 place-items-center rounded-sm bg-black/60 text-white/80 opacity-0 transition-opacity hover:bg-black/80 hover:text-white group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100';

  return (
    <div
      ref={boxRef}
      style={style}
      onClick={onSelect}
      title={onSelect ? selectHint : undefined}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect && !hidden ? 0 : undefined}
      aria-label={onSelect ? `${camera}: ${selectHint}` : `${camera} camera`}
      onKeyDown={(e) => {
        if (onSelect && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          e.stopPropagation();
          onSelect();
        }
      }}
      className={cn('group relative overflow-hidden bg-black', fill ? 'min-h-0' : 'aspect-video', hidden && 'hidden', onSelect && 'cursor-pointer')}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        className="absolute inset-0 size-full object-contain"
        onLoadedData={() => setLoaded(true)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onSeeked={() => setBuffering(false)}
        onLoadedMetadata={(e) => {
          if (media !== null) e.currentTarget.currentTime = media;
        }}
      />

      {(error || noSignal) && (
        <div className="absolute inset-0 grid place-items-center bg-[#0b0c0f] p-4 text-center">
          <div>
            {noSignal && !compact && <div className="text-[10px] font-medium tracking-[0.15em] text-white/40 uppercase">No signal</div>}
            <div className="mt-1 text-xs text-white/55">
              {!segments.length ? 'No video uploaded for this camera' : media === null ? 'No recording at this time' : error}
            </div>
          </div>
        </div>
      )}

      {(buffering || !loaded) && canPlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" role="status">
          <div className="size-5 animate-spin rounded-full border border-white/20 border-t-white/80" />
          <span className={cn('text-[11px] text-white/60', loaded && 'sr-only')}>{loaded ? 'Buffering' : 'Loading video…'}</span>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1 bg-gradient-to-b from-black/60 to-transparent px-1.5 pt-1.5 pb-5">
        <span className="rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white/90">
          {camera}
          {!compact && <span className="ml-1.5 text-white/40">{index + 1}</span>}
        </span>
        <span className="mr-auto" />
        {canPlay && !compact && (
          <button type="button" onClick={(e) => (e.stopPropagation(), snapshot())} className={tool} title="Save this frame as PNG" aria-label={`Save a ${camera} snapshot`}>
            <Camera className="size-3.5" aria-hidden />
          </button>
        )}
        {!compact && (
          <button type="button" onClick={(e) => (e.stopPropagation(), fullscreen())} className={tool} title="Fullscreen this camera" aria-label={`Fullscreen ${camera}`}>
            <Maximize className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
