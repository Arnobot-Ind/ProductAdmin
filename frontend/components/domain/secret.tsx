'use client';

import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { CopyButton, Mono } from '@/components/ui/misc';

/** Revealed secrets hide again after this many seconds. */
export const REVEAL_SECONDS = 30;

/** A decrypted secret on screen for REVEAL_SECONDS (robot and client credentials). Keep it in component state only. */
export function RevealPanel({ title, username, secret, onHide }: { title: string; username: string | null; secret: string; onHide: () => void }) {
  const [left, setLeft] = useState(REVEAL_SECONDS);
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;
  useEffect(() => {
    setLeft(REVEAL_SECONDS);
    const id = window.setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          window.clearInterval(id);
          onHideRef.current();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [secret]);
  return (
    <section aria-label="Revealed secret" className="rounded-lg border border-warn/50 bg-warn-bg p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-warn">
          <KeyRound className="size-4" aria-hidden /> {title}
        </p>
        <p className="text-xs text-fg" aria-live="off">
          Hides in {left}s
        </p>
      </div>
      {username && (
        <p className="mb-2 text-sm">
          Username: <Mono>{username}</Mono>
        </p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        <code className="min-w-0 flex-1 rounded bg-surface px-2 py-1.5 font-mono text-sm break-all whitespace-pre-wrap select-all">{secret}</code>
        <CopyButton value={secret} label="Copy secret" />
        <Button size="sm" icon={<EyeOff className="size-4" aria-hidden />} onClick={onHide}>
          Hide now
        </Button>
      </div>
    </section>
  );
}

/** Secret entry, hidden by default; multi-line for keys and config blobs. */
export function SecretInput({ value, onChange, multiline }: { value: string; onChange: (v: string) => void; multiline?: boolean }) {
  const [show, setShow] = useState(false);
  if (multiline) {
    return <Textarea value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />;
  }
  return (
    <div className="flex gap-2">
      <Input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" spellCheck={false} className="font-mono" />
      <Button size="md" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide secret' : 'Show secret'}>
        {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </Button>
    </div>
  );
}
