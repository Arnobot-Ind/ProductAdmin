'use client';

import { Check, ListFilter, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** One Filter button with all the filters behind it, so they take no room on the page. Esc or a click outside closes it. */
export function FilterMenu({ count, onClear, children }: { count: number; onClear?: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cn('inline-flex h-10 items-center gap-2 rounded-md border bg-surface px-3 text-base hover:bg-surface-2', count ? 'border-fg/50' : 'border-border')}>
        <ListFilter className="size-4" aria-hidden /> Filter
        {count > 0 && <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent text-xs font-medium text-accent-fg tabular-nums">{count}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-lg">
          {children}
          {onClear && (
            <button type="button" onClick={onClear} className="inline-flex items-center gap-1 self-start text-sm font-medium text-accent-text hover:underline">
              <X className="size-3.5" aria-hidden /> Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}

export function FilterChoice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div>
      <span className="mb-1 block text-sm text-muted">{label}</span>
      <div role="group" aria-label={label} className="flex rounded-md border border-border p-0.5">
        {options.map(([v, text]) => (
          <button key={text} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={cn('flex-1 rounded px-2 py-1 text-base', value === v ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A small Filter button whose options open on click, for one chart. Picking one, Esc or a click outside closes them. */
export function OptionFilter<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (id: T) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Filter ${label} by time`} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-sm hover:bg-surface-2">
        <ListFilter className="size-4" aria-hidden /> Filter
      </button>
      {open && (
        <div role="group" aria-label={`Time range for ${label}`} className="absolute right-0 z-30 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={value === o.id}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
              className={cn('flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-surface-2', value === o.id && 'font-medium')}
            >
              {o.label}
              {value === o.id && <Check className="size-4" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
