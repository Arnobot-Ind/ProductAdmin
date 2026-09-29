'use client';

import type { InviteInfoDto, MeDto } from '@arnobot/message-schema';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BrandMark } from '@/components/domain/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { InlineAlert, LoadingBlock } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

const MIN_PASSWORD = 10;

/**
 * Invitation link: /invite#<token>. The token sits in the URL fragment, so it is never sent to any server
 * (no access logs, no Referer); this page reads it and sends it only in the API request body.
 */
export default function InvitePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const tokenRef = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<InviteInfoDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Set your password · Arnobot PMS';
    // Read once (effects may run twice in development), then remove the token from the address bar and history.
    tokenRef.current ??= window.location.hash.replace(/^#/, '').trim();
    const t = tokenRef.current;
    window.history.replaceState(null, '', '/invite');
    if (!t) {
      setLoadError('This page needs the full link from your invitation. Open the link exactly as you received it.');
      return;
    }
    setToken(t);
    api
      .get<InviteInfoDto>('/auth/invite', { token: t })
      .then(setInfo)
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return setError(`The password must be at least ${MIN_PASSWORD} characters.`);
    if (password !== confirm) return setError('The passwords do not match.');
    setError(null);
    setBusy(true);
    try {
      const me = await api.post<MeDto>('/auth/invite/accept', { token, password });
      qc.setQueryData(['me'], me);
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandMark />
        </div>
        <div className="rounded-lg border border-border bg-surface p-6 shadow-xl">
          <h1 className="text-xl font-bold">Welcome to Arnobot PMS</h1>
          {loadError ? (
            <div className="mt-4 flex flex-col gap-3">
              <InlineAlert tone="fault" title="This invitation can't be used">
                {loadError}
              </InlineAlert>
              <a href="/login" className="text-sm font-medium text-accent-text hover:underline">
                Go to sign in
              </a>
            </div>
          ) : !info ? (
            <div className="mt-4">
              <LoadingBlock rows={3} label="Checking your invitation" />
            </div>
          ) : (
            <>
              <p className="mt-1 mb-5 text-sm text-muted">
                {info.name}, you have been invited as a member of <span className="font-semibold text-fg">{info.organization}</span>. Choose a password to finish. This link works
                once and expires {fmtDateTime(info.expires_at)}.
              </p>
              <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label="Email">
                  <Input type="email" autoComplete="username" value={info.email} readOnly />
                </Field>
                <Field label="New password" required hint={`At least ${MIN_PASSWORD} characters. A long passphrase is best.`}>
                  <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
                </Field>
                <Field label="Confirm password" required>
                  <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </Field>
                {error && <InlineAlert tone="fault">{error}</InlineAlert>}
                <Button type="submit" variant="primary" loading={busy} disabled={!password || !confirm}>
                  Set password and sign in
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
