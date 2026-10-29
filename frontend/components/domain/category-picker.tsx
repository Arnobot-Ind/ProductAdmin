'use client';

import type { RobotCategory } from '@arnobot/message-schema';
import { Plane, Truck } from 'lucide-react';
import { cn } from '@/lib/cn';

const OPTIONS: { value: RobotCategory; label: string; detail: string; Icon: typeof Truck }[] = [
  { value: 'ugv', label: 'UGV', detail: 'Ground robot', Icon: Truck },
  { value: 'uav', label: 'UAV', detail: 'Aerial robot (drone)', Icon: Plane },
];

/** The two robot categories as large choice cards (a radio group). */
export function CategoryPicker({ value, onChange, name = 'category' }: { value: RobotCategory | ''; onChange: (v: RobotCategory) => void; name?: string }) {
  return (
    <div role="radiogroup" aria-label="Category" className="grid grid-cols-2 gap-3">
      {OPTIONS.map((o) => {
        const on = value === o.value;
        return (
          <label
            key={o.value}
            className={cn('flex cursor-pointer items-center gap-3 rounded-xl border-2 p-3 transition-colors', on ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-accent/50')}
          >
            <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} className="sr-only" />
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: `var(--cat-${o.value})` }} aria-hidden>
              <o.Icon className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-lg font-semibold">{o.label}</span>
              <span className="block text-sm text-muted">{o.detail}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
