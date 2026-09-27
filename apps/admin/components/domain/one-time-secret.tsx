'use client';

import { KeyRound } from 'lucide-react';
import { CopyButton, InlineAlert, Mono } from '@/components/ui/misc';

/** A newly issued ingest key: shown exactly once, never stored by the PMS in plaintext. */
export function OneTimeKey({ value, title = 'Ingest key', children }: { value: string; title?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <InlineAlert tone="warn" title="Copy this key now: it will not be shown again">
        The PMS stores only a hash of it. Put it in the robot&apos;s or GCS server&apos;s environment (server side, never in a
        <Mono>NEXT_PUBLIC_*</Mono> variable). If it is lost, issue a new key and revoke the old one.
      </InlineAlert>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-3">
        <KeyRound className="size-4 text-muted" aria-hidden />
        <span className="sr-only">{title}:</span>
        <code className="min-w-0 flex-1 font-mono text-sm break-all select-all" data-testid="one-time-key">
          {value}
        </code>
        <CopyButton value={value} label="Copy key" />
      </div>
      {children}
    </div>
  );
}
