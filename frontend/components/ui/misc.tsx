'use client';

import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Inbox } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtRelative, fmtUtc } from '@/lib/format';
import { Button } from './button';

export type Tone = 'neutral' | 'ok' | 'warn' | 'fault' | 'offline' | 'accent';
const toneClass: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg border-border',
  ok: 'bg-ok-bg text-ok border-ok/30',
  warn: 'bg-warn-bg text-warn border-warn/30',
  fault: 'bg-fault-bg text-fault border-fault/30',
  offline: 'bg-offline-bg text-offline border-offline/30',
  accent: 'bg-accent-soft text-accent-text border-accent/30',
};

export function Badge({ tone = 'neutral', icon, children, className, title }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap', toneClass[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          {title && <h2 className="text-sm font-semibold tracking-wide">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {/* A custom body class replaces the default padding (cn() does not resolve Tailwind conflicts). */}
      <div className={bodyClassName ?? 'p-4'}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, eyebrow, description, actions }: { title: ReactNode; eyebrow?: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h1 className="text-2xl font-bold">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <span className="text-muted" aria-hidden>
        {icon ?? <Inbox className="size-8" />}
      </span>
      <p className="font-semibold">{title}</p>
      {description && <p className="max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-fault/40 bg-fault-bg px-4 py-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-fault">
        <AlertTriangle className="size-4" aria-hidden /> Could not load data
      </p>
      <p className="text-fg">{errorMessage(error)}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} aria-hidden />;
}

export function LoadingBlock({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** Renders loading / error / content for a TanStack query result. */
export function QueryView<T>({
  query,
  children,
  rows,
}: {
  query: { data: T | undefined; isLoading: boolean; error: unknown; refetch: () => unknown };
  children: (data: T) => ReactNode;
  rows?: number;
}) {
  if (query.isLoading) return <LoadingBlock rows={rows} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return <LoadingBlock rows={rows} />;
  return <>{children(query.data)}</>;
}

/** Local time with the exact UTC value on hover. */
export function Time({ iso, relative, now }: { iso: string | null | undefined; relative?: boolean; now?: number }) {
  if (!iso) return <span className="text-muted">—</span>;
  return (
    <time dateTime={iso} title={`${fmtDateTime(iso)} · ${fmtUtc(iso) ?? ''}`}>
      {relative ? fmtRelative(iso, now) : fmtDateTime(iso)}
    </time>
  );
}

export function KeyValue({ items, columns = 2 }: { items: { label: ReactNode; value: ReactNode }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium tracking-wide text-muted uppercase">{it.label}</dt>
          <dd className="mt-0.5 break-words">{it.value ?? <span className="text-muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
      icon={copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
    >
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </Button>
  );
}

export function Pagination({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <nav aria-label="Pagination" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
      <p aria-live="polite">
        {from}–{to} of {total.toLocaleString()}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1} icon={<ChevronLeft className="size-4" aria-hidden />}>
          Previous
        </Button>
        <span>
          Page {page} of {pages}
        </span>
        <Button size="sm" onClick={() => onPage(page + 1)} disabled={page >= pages}>
          Next <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.8125rem]', className)}>{children}</code>;
}

export function InlineAlert({ tone = 'warn', title, children }: { tone?: 'warn' | 'fault' | 'ok' | 'accent'; title?: ReactNode; children: ReactNode }) {
  return (
    <div role={tone === 'fault' ? 'alert' : 'note'} className={cn('rounded-md border px-3 py-2.5 text-sm', toneClass[tone])}>
      {title && <p className="mb-0.5 font-semibold">{title}</p>}
      <div className="text-fg">{children}</div>
    </div>
  );
}
