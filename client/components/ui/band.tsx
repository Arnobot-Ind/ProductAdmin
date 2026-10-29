import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The brand band: a pale-blue panel (deep blue in dark mode; its own tokens, see .band in globals.css) with a faint
 * dot grid fading in from the left. Used for a page's headline facts: the dashboard hero, a robot's summary.
 */
export function Band({ children, className, label, labelledBy }: { children: ReactNode; className?: string; label?: string; labelledBy?: string }) {
  return (
    <section aria-label={label} aria-labelledby={labelledBy} className={cn('band relative overflow-hidden rounded-2xl border border-border bg-surface shadow-sm', className)}>
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage: 'radial-gradient(var(--band-dot) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
          maskImage: 'linear-gradient(to right, transparent 15%, black 75%)',
          WebkitMaskImage: 'linear-gradient(to right, transparent 15%, black 75%)',
        }}
        aria-hidden
      />
      <div className="relative">{children}</div>
    </section>
  );
}

/** One headline fact inside a band: a muted label over a large value, divided from its neighbours by hairlines. */
export function BandFact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-base text-muted">{label}</dt>
      <dd className="mt-1 truncate text-lg font-semibold">{children}</dd>
    </div>
  );
}

/** Battery-style meter: the fill carries severity (accent, warning below 30 %, critical below 15 %) on a light track of the same ramp. */
export function BandMeter({ pct, label = 'Battery' }: { pct: number | null; label?: string }) {
  if (pct === null) return <span className="text-base font-semibold">Not reported</span>;
  const v = Math.max(0, Math.min(100, pct));
  const fill = v < 15 ? 'var(--chart-critical)' : v < 30 ? 'var(--chart-warning)' : 'var(--accent)';
  return (
    <span className="flex items-center gap-3">
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-accent-soft" role="meter" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span className="block h-full rounded-full" style={{ width: `${v}%`, background: fill }} />
      </span>
      <span className="w-12 text-right text-base font-semibold">{Math.round(v)} %</span>
    </span>
  );
}
