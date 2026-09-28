'use client';

import type { RealtimeChange } from '@arnobot/message-schema';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';

/** Browser-safe endpoint only (no credentials in it). The session cookie authenticates the handshake. */
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000';

/** While the socket is down, pages fall back to polling at this interval. */
export const FALLBACK_POLL_MS = 15_000;

const RealtimeContext = createContext<{ connected: boolean }>({ connected: false });

export function useRealtime() {
  return useContext(RealtimeContext);
}

/** refetchInterval to pass to live-ish queries: off while pushed updates flow, polling otherwise. */
export function useLivePoll(): number | false {
  return useContext(RealtimeContext).connected ? false : FALLBACK_POLL_MS;
}

function keysFor(c: RealtimeChange): QueryKey[] {
  const r = c.robot_id;
  switch (c.kind) {
    case 'live':
      return [['robots'], ['robot', r, 'detail'], ['robot', r, 'live'], ['dashboard']];
    case 'seen':
      return [['robots'], ['robot', r, 'detail'], ['robot', r, 'live'], ['robot', r, 'archive'], ['dashboard'], ['system-status']];
    case 'archive':
      return [['archive'], ['robot', r, 'archive'], ['robots'], ['robot', r, 'detail']];
    case 'event':
      return [['robot', r, 'events'], ['robots'], ['dashboard']];
    case 'mission':
      return [['mission', c.mission_id], ['robot', r, 'missions'], ['robots'], ['robot', r, 'detail'], ['dashboard']];
    case 'software':
      return [['robot', r, 'software'], ['robot', r, 'detail'], ['robots']];
    case 'telemetry':
      return [['robot', r, 'telemetry']];
    default:
      return [];
  }
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const pending = useRef(new Map<string, QueryKey>());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const socket: Socket = io(WS_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 10_000,
    });
    const flush = () => {
      timer.current = null;
      for (const key of pending.current.values()) void qc.invalidateQueries({ queryKey: key });
      pending.current.clear();
    };
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('change', (change: RealtimeChange) => {
      // Coalesce bursts (a backlog upload can push hundreds of changes) into one refetch per key.
      for (const k of keysFor(change)) pending.current.set(JSON.stringify(k), k);
      if (timer.current === null) timer.current = window.setTimeout(flush, 400);
    });
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      socket.disconnect();
    };
  }, [qc]);

  return <RealtimeContext.Provider value={{ connected }}>{children}</RealtimeContext.Provider>;
}
