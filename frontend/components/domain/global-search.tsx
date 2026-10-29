'use client';

import type { SearchResultDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, Boxes, Building2, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useDebounced } from '@/lib/hooks';

interface Hit {
  key: string;
  href: string;
  title: string;
  sub: string;
  Icon: typeof Bot;
  group: string;
}

/**
 * The top bar's search: any robot (by ID, serial number, product or owner), organization or product, from every page.
 * "/" focuses it; arrows and Enter pick a result. Built for a large fleet: the server returns the best few of each kind.
 */
export function GlobalSearch() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const q = useDebounced(text.trim(), 200);
  const res = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<SearchResultDto>('/search', { q }),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', close);
    };
  }, []);

  const d = q ? res.data : undefined;
  const hits: Hit[] = [
    ...(d?.robots ?? []).map((r) => ({
      key: `r-${r.robot_id}`,
      href: `/robots/${r.robot_id}`,
      title: r.nickname ? `${r.robot_id} · ${r.nickname}` : r.robot_id,
      sub: [`${r.category.toUpperCase()} · ${r.product_name}`, r.attachments.length ? r.attachments.join(', ') : null, `SN ${r.serial_number}`, r.owner_company].filter(Boolean).join(' · '),
      Icon: Bot,
      group: 'Robots',
    })),
    ...(d?.organizations ?? []).map((o) => ({ key: `o-${o.id}`, href: `/admin/organizations/${o.id}`, title: o.name, sub: o.kind === 'internal' ? 'Arnobot' : 'Customer', Icon: Building2, group: 'Organizations' })),
    ...(d?.products ?? []).map((p) => ({ key: `p-${p.id}`, href: `/products/${p.id}`, title: p.name, sub: `${p.category.toUpperCase()} base model · ${p.code}`, Icon: Boxes, group: 'Base models' })),
  ];
  const go = (h: Hit) => {
    setOpen(false);
    setText('');
    input.current?.blur();
    router.push(h.href);
  };

  return (
    <div ref={box} className="relative hidden w-full max-w-md lg:block">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={input}
        role="combobox"
        aria-expanded={open && !!q}
        aria-controls={listId}
        aria-label="Search robots, organizations and base models"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          if (e.key === 'Enter' && hits[active]) (e.preventDefault(), go(hits[active]));
          if (e.key === 'Escape') (setOpen(false), input.current?.blur());
        }}
        placeholder="Search robot, nickname, serial, owner…"
        className="h-10 w-full rounded-lg border border-border bg-surface-2 pr-10 pl-9 text-base focus:border-accent focus:bg-surface focus:outline-none"
        autoComplete="off"
        spellCheck={false}
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-border px-1.5 text-xs text-muted" aria-hidden>
        /
      </kbd>
      {open && q && (
        <ul id={listId} role="listbox" className="absolute z-50 mt-1 max-h-[70vh] w-full overflow-auto rounded-xl border border-border bg-surface py-1 shadow-xl">
          {res.isLoading ? (
            <li className="px-4 py-3 text-sm text-muted">Searching…</li>
          ) : hits.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted">Nothing matches “{q}”.</li>
          ) : (
            hits.map((h, i) => (
              <li key={h.key} role="option" aria-selected={i === active}>
                {(i === 0 || hits[i - 1].group !== h.group) && <p className="px-4 pt-2 pb-1 text-xs font-semibold tracking-[0.12em] text-muted uppercase">{h.group}</p>}
                <button
                  type="button"
                  onMouseDown={(e) => (e.preventDefault(), go(h))}
                  onMouseEnter={() => setActive(i)}
                  className={cn('flex w-full items-center gap-3 px-4 py-2 text-left', i === active && 'bg-surface-2')}
                >
                  <h.Icon className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{h.title}</span>
                    <span className="block truncate text-sm text-muted">{h.sub}</span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
