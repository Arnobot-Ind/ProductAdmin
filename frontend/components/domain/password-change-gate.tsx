'use client';

import type { MeDto } from '@arnobot/message-schema';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { InlineAlert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { BrandMark } from './brand';

const MIN_PASSWORD = 10;

/**
 * Signed in with a temporary password (given by an administrator): the API refuses everything else until it is
 * changed, so this screen replaces the whole panel.
 */
export function PasswordChangeGate({ me }: { me: MeDto }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < MIN_PASSWORD) return setError(`The new password must be at least ${MIN_PASSWORD} characters.`);
    if (next !== confirm) return setError('The new passwords do not match.');
    if (next === current) return setError('Choose a password different from the temporary one.');
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/change-password', { current_password: current, new_password: next });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    window.location.assign('/login');
  };

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-sm">
        <div className="mb-5 flex items-center justify-between">
          <BrandMark />
          <Button size="sm" variant="ghost" icon={<LogOut className="size-4" aria-hidden />} onClick={logout}>
            Sign out
          </Button>
        </div>
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <KeyRound className="size-5" aria-hidden /> Choose your own password
        </h1>
        <p className="mt-1 mb-4 text-sm text-muted">
          {me.name}, you signed in with a temporary password from your administrator ({me.organization?.name ?? 'Arnobot'}). Set a new one to continue.
        </p>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
          <Field label="Temporary password" required>
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
          </Field>
          <Field label="New password" required hint={`At least ${MIN_PASSWORD} characters. A long passphrase is best.`}>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password" required>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          {error && <InlineAlert tone="fault">{error}</InlineAlert>}
          <Button type="submit" variant="primary" loading={busy} disabled={!current || !next || !confirm}>
            Set password and continue
          </Button>
        </form>
      </div>
    </main>
  );
}
