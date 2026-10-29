'use client';

import type { Paginated, RobotListItemDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useDebounced } from '@/lib/hooks';

/**
 * Pick one robot by typing part of its ID, serial number or owner: works the same for 10 robots or 10 000, since
 * only the best 20 matches are fetched. `exclude` hides robots that cannot be chosen (e.g. already assigned).
 */
export function RobotPicker({
  value,
  onChange,
  exclude,
  placeholder = 'Type a robot ID, nickname, serial number or owner…',
  autoFocus,
  invalid,
}: {
  value: string;
  onChange: (robotId: string, robot: RobotListItemDto | null) => void;
  exclude?: Set<string>;
  placeholder?: string;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim(), 200);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  // Follow a value set from outside (not the empty value sent while typing).
  useEffect(() => {
    if (value) setText(value);
  }, [value]);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const res = useQuery({
    queryKey: ['robots', 'picker', q],
    queryFn: () => api.get<Paginated<RobotListItemDto>>('/robots', { q: q || undefined, limit: 21, sort: 'robot_id' }),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const items = (res.data?.items ?? []).filter((r) => !exclude?.has(r.robot_id) && !r.deleted_at).slice(0, 20);
  const more = (res.data?.total ?? 0) > 21;
  const pick = (r: RobotListItemDto) => {
    onChange(r.robot_id, r);
    setText(r.robot_id);
    setOpen(false);
  };
  return (
    <div ref={box} className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        data-autofocus={autoFocus || undefined}
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          if (value) onChange('', null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setOpen(true), setActive((a) => Math.min(a + 1, items.length - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          if (e.key === 'Enter' && open && items[active]) (e.preventDefault(), pick(items[active]));
          if (e.key === 'Escape') setOpen(false);
        }}
        className="h-10 w-full rounded-md border border-border bg-surface pr-9 pl-9 font-mono text-base focus:border-accent focus:outline-none aria-[invalid=true]:border-fault"
        spellCheck={false}
        autoComplete="off"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear"
          onClick={() => {
            setText('');
            onChange('', null);
            setOpen(true);
          }}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-fg"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
      {open && (
        <ul id={listId} role="listbox" className="absolute z-40 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg">
          {res.isLoading ? (
            <li className="px-3 py-2 text-sm text-muted">Searching…</li>
          ) : items.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">No robot matches “{text}”.</li>
          ) : (
            items.map((r, i) => (
              <li
                key={r.robot_id}
                role="option"
                aria-selected={r.robot_id === value}
                onMouseDown={(e) => (e.preventDefault(), pick(r))}
                onMouseEnter={() => setActive(i)}
                className={cn('flex cursor-pointer items-center gap-3 px-3 py-2', i === active && 'bg-surface-2')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">
                    <span className="font-mono">{r.robot_id}</span>
                    {r.nickname && ` · ${r.nickname}`}
                  </span>
                  <span className="block truncate text-sm text-muted">
                    {[`${r.category.toUpperCase()} · ${r.product_name}`, r.attachments.map((a) => a.name).join(', ') || null, `SN ${r.serial_number}`, r.owner_company ?? 'no owner'].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {r.robot_id === value && <Check className="size-4 text-accent-text" aria-hidden />}
              </li>
            ))
          )}
          {more && <li className="border-t border-border px-3 py-2 text-sm text-muted">Showing the first 20: type more to narrow it down.</li>}
        </ul>
      )}
    </div>
  );
}
