'use client';

import type { RobotActivityDayDto, RobotLogDto, RobotLogEntryDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Inbox } from 'lucide-react';
import { useState } from 'react';
import { CalendarLayout, istToday, MonthCalendar } from '@/components/domain/activity-calendar';
import { Input, Select } from '@/components/ui/field';
import { FilterField, FilterMenu } from '@/components/ui/filter-menu';
import { Badge, EmptyState, Pagination, QueryView } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useLivePoll } from '@/lib/realtime';

/** What each kind of machine message is, in words. */
const TYPES: Record<string, string> = {
  live: 'Live status',
  telemetry: 'Sensor data',
  event: 'Event',
  hello: 'Startup',
  mission: 'Mission',
  detection: 'Detection',
};

const IST = 'Asia/Kolkata';
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: IST });
const dayTitle = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const istStart = (d: string) => `${d}T00:00:00+05:30`;
const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const nextDay = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

/**
 * The machine's own log: every message the robot sent, exactly as it sent it, newest first. Each line shows its values;
 * a click opens the whole message. The calendar on the left picks a day; the other filters are behind the Filter button. Times are IST.
 */
export function RobotLogTab({ robotId, day }: { robotId: string; day?: string | null }) {
  const poll = useLivePoll();
  const [type, setType] = useState('');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 350);
  const [from, setFrom] = useState(day ?? '');
  const [to, setTo] = useState(day ?? '');
  const [page, setPage] = useState(1);
  const limit = 50;
  const query = useQuery({
    queryKey: ['robot', robotId, 'machine-log', type, q, from, to, page],
    queryFn: () =>
      api.get<RobotLogDto>(`/robots/${robotId}/log`, {
        kinds: 'message',
        include_messages: 1,
        page,
        limit,
        message_type: type || undefined,
        q: q || undefined,
        from: from ? istStart(from) : undefined,
        to: to ? istStart(nextDay(to)) : undefined,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: page === 1 ? poll || 120_000 : false,
  });
  // A single day picked on the calendar counts as one filter, not two dates.
  const pickedDay = from && from === to ? from : null;
  const active = [type, q, pickedDay ?? from, pickedDay ? '' : to].filter(Boolean).length;
  const set = (fn: (v: string) => void) => (v: string) => {
    fn(v);
    setPage(1);
  };
  const clear = () => {
    setType('');
    setText('');
    setFrom('');
    setTo('');
    setPage(1);
  };
  return (
    <CalendarLayout
      calendar={
        <LogCalendar
          robotId={robotId}
          day={pickedDay}
          onDay={(d) => {
            setFrom(d ?? '');
            setTo(d ?? '');
            setPage(1);
          }}
        />
      }
    >
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base text-muted" aria-live="polite">
          {query.data ? `${query.data.total.toLocaleString('en-IN')} messages from the machine${pickedDay ? ` on ${shortDay(pickedDay)}` : ''}` : ' '}
        </p>
        <FilterMenu count={active} onClear={active ? clear : undefined}>
          <FilterField label="Message type">
            <Select value={type} onChange={(e) => set(setType)(e.target.value)}>
              <option value="">All messages</option>
              {Object.entries(TYPES).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField label="Search in messages">
            <Input value={text} onChange={(e) => set(setText)(e.target.value)} placeholder="e.g. GPS, AUTO, a mission name" />
          </FilterField>
          <FilterField label="From">
            <Input type="date" value={from} max={to || undefined} onChange={(e) => set(setFrom)(e.target.value)} />
          </FilterField>
          <FilterField label="To">
            <Input type="date" value={to} min={from || undefined} onChange={(e) => set(setTo)(e.target.value)} />
          </FilterField>
        </FilterMenu>
      </div>
      <QueryView query={query} rows={8}>
        {(d) =>
          !d.available.includes('message') ? (
            <EmptyState title="Not available" description="Your role cannot read the machine's messages." />
          ) : d.items.length === 0 ? (
            <EmptyState icon={<Inbox className="size-6" />} title={active ? 'No messages match these filters' : 'No messages from this machine yet'} />
          ) : (
            <>
              <Timeline items={d.items} />
              <Pagination page={d.page} limit={d.limit} total={d.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
    </div>
    </CalendarLayout>
  );
}

/** A month with each day shaded by how many messages the machine sent; a click shows only that day. */
function LogCalendar({ robotId, day, onDay }: { robotId: string; day: string | null; onDay: (d: string | null) => void }) {
  const [month, setMonth] = useState((day ?? istToday()).slice(0, 7));
  const q = useQuery({
    queryKey: ['robot', robotId, 'activity', month],
    queryFn: () => api.get<RobotActivityDayDto[]>(`/robots/${robotId}/activity/calendar`, { month }),
    placeholderData: keepPreviousData,
    staleTime: 120_000,
  });
  const byDay = new Map((q.data ?? []).map((d) => [d.date, d.messages]));
  return <MonthCalendar month={month} onMonth={setMonth} loading={q.isFetching && !q.data} value={(c) => ({ n: byDay.get(c) ?? 0, alert: 0 })} label={(n) => `${n.toLocaleString('en-IN')} message${n === 1 ? '' : 's'}`} day={day} onDay={onDay} />;
}

function Timeline({ items }: { items: RobotLogEntryDto[] }) {
  const groups: { key: string; title: string; items: RobotLogEntryDto[] }[] = [];
  for (const it of items) {
    const key = it.ts ? dayKey(it.ts) : 'unknown';
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(it);
    else groups.push({ key, title: it.ts ? dayTitle(it.ts) : 'Date unknown', items: [it] });
  }
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.title}>
          <h3 className="mb-2 text-base font-semibold">{g.title}</h3>
          <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {g.items.map((it) => (
              <li key={it.ref}>
                <Line it={it} />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** A message's values as short "name: value" pairs, nested ones as "battery pct: 82". */
function pairs(value: unknown, prefix = ''): [string, string][] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return prefix ? [[prefix, `${value.length} items`]] : [];
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => pairs(v, prefix ? `${prefix} ${k}` : k));
  return [[prefix.replace(/_/g, ' '), typeof value === 'number' ? String(+value.toFixed(3)) : String(value)]];
}

function Line({ it }: { it: RobotLogEntryDto }) {
  const [open, setOpen] = useState(false);
  let parsed: unknown = null;
  try {
    parsed = it.body ? JSON.parse(it.body) : null;
  } catch {
    parsed = null;
  }
  const values = pairs(parsed);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-surface-2">
        <Chevron className="mt-1 size-4 shrink-0 text-muted" aria-hidden />
        <span className="w-20 shrink-0 text-sm text-muted tabular-nums">{it.ts ? clock(it.ts) : '—'}</span>
        <span className="w-28 shrink-0">
          <Badge tone="neutral">{TYPES[it.title] ?? it.title}</Badge>
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">
          {values.length ? (
            values.slice(0, 8).map(([k, v]) => (
              <span key={k} className="mr-3">
                <span className="text-muted">{k}:</span> {v}
              </span>
            ))
          ) : (
            <span className="text-muted">{it.body ?? 'No values'}</span>
          )}
        </span>
      </button>
      {open && <pre className="max-h-96 overflow-auto border-t border-border bg-surface-2 px-4 py-3 font-mono text-sm break-words whitespace-pre-wrap">{parsed ? JSON.stringify(parsed, null, 2) : it.body}</pre>}
    </div>
  );
}
