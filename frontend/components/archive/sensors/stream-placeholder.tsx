import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Stands in for a data stream that is not there (not uploaded, unreadable, storage down). Same footprint as
 * the real view, so the page layout never jumps and never breaks.
 */
export function StreamPlaceholder({
  icon,
  title,
  children,
  tone = 'neutral',
  className,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  tone?: 'neutral' | 'warn' | 'fault';
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="note"
      className={cn(
        'flex min-h-48 flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 py-8 text-center',
        tone === 'neutral' && 'border-border bg-surface-2/40',
        tone === 'warn' && 'border-warn/40 bg-warn-bg/40',
        tone === 'fault' && 'border-fault/40 bg-fault-bg/40',
      )}
    >
      <span className={cn('text-muted', tone === 'warn' && 'text-warn', tone === 'fault' && 'text-fault', className)} aria-hidden>
        {icon}
      </span>
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
