'use client';

import type { RobotLogDto, RobotLogEntryDto, RobotLogKind } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bell, Building2, Cpu, FileText, Inbox, Package, Route, ScrollText, Search, ShieldAlert, Wrench, X } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { missionHref } from '@/components/domain/missions-table';
import { Field, Input } from '@/components/ui/field';
import { Badge, Card, EmptyState, Pagination, QueryView, type Tone } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useDebounced } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

const KIND: Record<RobotLogKind, { label: string; Icon: typeof Bell }> = {
  event: { label: 'Events', Icon: Bell },
  mission: { label: 'Missions', Icon: Route },
  hardware: { label: 'Hardware', Icon: Cpu },
  maintenance: { label: 'Repairs', Icon: Wrench },
  software: { label: 'Software', Icon: Package },
  ownership: { label: 'Ownership', Icon: Building2 },
  document: { label: 'Documents', Icon: FileText },
  audit: { label: 'Audit', Icon: ScrollText },
  rejection: { label: 'Rejected messages', Icon: ShieldAlert },
  message: { label: 'Robot messages', Icon: Inbox },
};

/** Severity → badge tone; anything unknown reads as neutral information. */
const LEVEL: Record<string, { tone: Tone; label: string }> = {
  critical: { tone: 'fault', label: 'Critical' },
  fault: { tone: 'fault', label: 'Fault' },
  error: { tone: 'fault', label: 'Error' },
  warning: { tone: 'warn', label: 'Warning' },
  ok: { tone: 'ok', label: 'OK' },
};

const IST = 'Asia/Kolkata';
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: IST });
const dayTitle = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** A YYYY-MM-DD date input as the start of that IST day (ISO, with offset). */
const istStart = (d: string) => `${d}T00:00:00+05:30`;
const nextDay = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

/**
 * Logs: everything that happened to this robot in one timeline, newest first — events, missions, hardware fitted
 * and removed, repairs, software reports, owner changes, documents, and (with the permission) audit entries and
 * raw robot messages. Filter by type, text and date (or pick a day on the calendar beside it). Times are IST.
 */
export function RobotLogTab({ robotId, day, onClearDay }: { robotId: string; day?: string | null; onClearDay?: () => void }) {
  const poll = useLivePoll();
  const [hidden, setHidden] = useState<Set<RobotLogKind>>(new Set());
  const [messages, setMessages] = useState(false);
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 350);
  // The calendar's day fills From and To (still editable here); clearing the day clears them.
  const [from, setFrom] = useState(day ?? '');
  const [to, setTo] = useState(day ?? '');
  const [page, setPage] = useState(1);
  const [shownDay, setShownDay] = useState(day);
  if (shownDay !== day) {
    setShownDay(day);
    setFrom(day ?? '');
    setTo(day ?? '');
    setPage(1);
  }
  const limit = 50;

  const query = useQuery({
    queryKey: ['robot', robotId, 'log', [...hidden].sort().join(','), messages, q, from, to, page],
    queryFn: async () => {
      // First learn which kinds exist for this user, then ask only for the visible ones.
      const params: Record<string, string | number> = { page, limit };
      if (q) params.q = q;
      if (from) params.from = istStart(from);
      if (to) params.to = istStart(nextDay(to));
      if (messages) params.include_messages = 1;
      if (hidden.size) {
        const all = (Object.keys(KIND) as RobotLogKind[]).filter((k) => k !== 'message' || messages);
        params.kinds = all.filter((k) => !hidden.has(k)).join(',') || 'none';
      }
      return api.get<RobotLogDto>(`/robots/${robotId}/log`, params);
    },
    placeholderData: keepPreviousData,
    refetchInterval: page === 1 ? poll || 120_000 : false,
  });

  const toggle = (k: RobotLogKind) => {
    setPage(1);
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const filtered = hidden.size > 0 || !!q || !!from || !!to;

  return (
    <div className="flex flex-col gap-5">
      <Card bodyClassName="flex flex-col gap-4 p-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="Search">
            <span className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setPage(1);
                }}
                placeholder="e.g. GPS, aborted, LiDAR, a serial number…"
                className="pl-9"
              />
            </span>
          </Field>
          <Field label="From">
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show log types">
          {(query.data?.available ?? []).map((k) => {
            if (k === 'message' && !messages) return null;
            const on = !hidden.has(k);
            const K = KIND[k];
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(k)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                  on ? 'border-accent bg-accent-soft text-accent-text' : 'border-border bg-surface text-muted line-through decoration-1 hover:text-fg',
                )}
              >
                <K.Icon className="size-4" aria-hidden />
                {K.label}
                <span className="tabular-nums">{query.data?.counts[k] ?? 0}</span>
              </button>
            );
          })}
          {query.data?.available.includes('message') && (
            <label className="ml-auto inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={messages}
                onChange={(e) => {
                  setMessages(e.target.checked);
                  setPage(1);
                }}
                className="size-4 accent-[var(--accent)]"
              />
              Include raw robot messages
            </label>
          )}
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setHidden(new Set());
                setText('');
                setFrom('');
                setTo('');
                setPage(1);
                onClearDay?.();
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-accent-text hover:underline"
            >
              <X className="size-4" aria-hidden /> Clear filters
            </button>
          )}
        </div>
      </Card>

      <QueryView query={query} rows={8}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={filtered ? 'Nothing matches these filters' : 'Nothing logged yet'} description={filtered ? 'Try another word, a wider date range or more types.' : 'Events, missions, hardware and software changes appear here as they happen.'} />
          ) : (
            <>
              <Timeline robotId={robotId} items={d.items} />
              <Pagination page={d.page} limit={d.limit} total={d.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
    </div>
  );
}

function Timeline({ robotId, items }: { robotId: string; items: RobotLogEntryDto[] }) {
  // Group by IST day, keeping the newest-first order.
  const groups: { key: string; title: string; items: RobotLogEntryDto[] }[] = [];
  for (const it of items) {
    const key = it.ts ? dayKey(it.ts) : 'unknown';
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(it);
    else groups.push({ key, title: it.ts ? dayTitle(it.ts) : 'Date unknown', items: [it] });
  }
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.title}>
          <h3 className="mb-3 text-base font-semibold">{g.title}</h3>
          <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {g.items.map((it) => (
              <li key={`${it.kind}-${it.ref}-${it.ts}`}>
                <Entry robotId={robotId} it={it} />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Entry({ robotId, it }: { robotId: string; it: RobotLogEntryDto }) {
  const K = KIND[it.kind];
  const level = LEVEL[it.level];
  const href = it.kind === 'mission' ? missionHref({ robot_id: robotId, mission_id: it.ref }) : it.kind === 'event' ? `/robots/${robotId}?tab=events` : null;
  const title: ReactNode = href ? (
    <Link href={href} className="font-semibold text-accent-text hover:underline">
      {it.title}
    </Link>
  ) : (
    <span className="font-semibold">{it.title}</span>
  );
  return (
    <div className="flex items-start gap-4 px-5 py-3">
      <span className="w-20 shrink-0 pt-0.5 text-sm text-muted tabular-nums">{it.ts ? clock(it.ts) : '—'}</span>
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg',
          level?.tone === 'fault' ? 'bg-fault-bg text-fault' : level?.tone === 'warn' ? 'bg-warn-bg text-warn' : level?.tone === 'ok' ? 'bg-ok-bg text-ok' : 'bg-surface-2 text-muted',
        )}
        aria-hidden
      >
        <K.Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          {title}
          <Badge tone="neutral">{K.label}</Badge>
          {level && <Badge tone={level.tone}>{level.label}</Badge>}
          {it.actor && <span className="text-sm text-muted">· {it.actor}</span>}
        </span>
        {it.body && <span className="mt-0.5 block text-sm break-words text-muted">{it.body}</span>}
      </span>
    </div>
  );
}
