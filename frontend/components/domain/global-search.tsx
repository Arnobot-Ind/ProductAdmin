'use client';

import { fmtSerial } from '@/lib/format';
import type { SearchResultDto } from '@arnobot/message-schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { ACTIONS, matchPages, NAV, visibleNav } from './nav';
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
 * The top bar's search, from every page: any robot (by serial, nickname, base model or owner), plus the app's pages and
 * common actions the user may use. "/" focuses it; arrows and Enter pick a result.
 */
export function GlobalSearch() {
  const router = useRouter();
  const can = useCan();
  const pages = useMemo(() => {
    const section = 'Pages';
    return [...visibleNav(NAV, can).map((i) => ({ ...i, section })), ...ACTIONS.filter((i) => !i.perm || can(i.perm))];
  }, [can]);
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
  const pageHits = matchPages(pages, text.trim()).slice(0, 6);
  const hits: Hit[] = [
    ...(d?.robots ?? []).map((r) => ({
      key: `r-${r.robot_id}`,
      href: `/robots/${r.robot_id}`,
      title: `${r.nickname ?? r.product_name} · ${fmtSerial(r.robot_id)}`,
      sub: [`${r.category.toUpperCase()} · ${r.product_name}`, r.attachments.length ? r.attachments.join(', ') : null, r.owner_company].filter(Boolean).join(' · '),
      Icon: Bot,
      group: 'Robots',
    })),
    ...pageHits.map((p) => ({ key: `page-${p.label}`, href: p.href, title: p.label, sub: p.description, Icon: p.Icon, group: 'Pages' })),
  ];
  const go = (h: Hit) => {
    setOpen(false);
    setText('');
    input.current?.blur();
    router.push(h.href);
  };

  return (
    <div ref={box} className="relative hidden w-full max-w-xs lg:block">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={input}
        role="combobox"
        aria-expanded={open && !!q}
        aria-controls={listId}
        aria-label="Search robots and pages"
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
        placeholder="Search robots"
        className="h-9 w-full rounded-md border border-transparent bg-surface-2 pr-8 pl-8 text-base focus:border-border focus:bg-surface focus:outline-none"
        autoComplete="off"
        spellCheck={false}
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-border px-1.5 text-xs text-muted" aria-hidden>
        /
      </kbd>
      {open && text.trim() && (
        <ul id={listId} role="listbox" className="absolute z-50 mt-1 max-h-[70vh] w-full overflow-auto rounded-xl border border-border bg-surface py-1 shadow-xl">
          {hits.length === 0 && (res.isLoading || !q) ? (
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
