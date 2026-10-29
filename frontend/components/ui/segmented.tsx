import { cn } from '@/lib/cn';

/** A row of mutually exclusive choices (a period, a metric), the chosen one filled. */
export function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[] }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5">
      {options.map(([k, text]) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={cn('rounded-md px-3 py-1 text-sm font-medium', value === k ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
