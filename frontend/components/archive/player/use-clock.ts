'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Session playback clock in wall-clock epoch ms. Every camera follows it. */
export function useClock(start: number, end: number, initial = start) {
  const [time, setTime] = useState(() => Math.max(start, Math.min(end, initial)));
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const timeRef = useRef(time);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(end, timeRef.current + (now - last) * rate);
      last = now;
      timeRef.current = next;
      setTime(next);
      if (next >= end) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, end]);

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(start, Math.min(end, t));
      timeRef.current = clamped;
      setTime(clamped);
    },
    [start, end],
  );

  const toggle = useCallback(() => {
    if (timeRef.current >= end) seek(start);
    setPlaying((p) => !p);
  }, [end, start, seek]);

  return { time, playing, rate, setRate, seek, toggle, setPlaying };
}

export type Clock = ReturnType<typeof useClock>;

/** 09:04:31 in local time. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 20260923T090000Z (UTC), used in shareable ?t= links. */
export function fmtChunkTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function parseChunkTime(v: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
}

/** 3725 → "1:02:05", 65 → "1:05". */
export function fmtSpan(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
