'use client';

import type { MeDto } from '@arnobot/message-schema';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { BrandMark } from '@/components/domain/brand';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { api, ApiError, errorMessage } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Sign in · Arnobot PMS';
  }, []);

  // Only allow same-site relative redirects (no open redirect).
  const next = (() => {
    const n = params.get('next');
    return n && n.startsWith('/') && !n.startsWith('//') ? n : '/';
  })();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.post<MeDto>('/auth/login', { email: email.trim(), password });
      qc.setQueryData(['me'], me);
      router.replace(next);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Email or password is incorrect.' : errorMessage(err));
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
          <h1 className="text-xl font-bold">Sign in</h1>
          <p className="mt-1 mb-5 text-sm text-muted">Arnobot team access only.</p>
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <Field label="Email" required>
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <Field label="Password" required>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && (
              <p role="alert" className="rounded-md border border-fault/40 bg-fault-bg px-3 py-2 text-sm text-fault">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>
              Sign in
            </Button>
          </form>
        </div>
        <p className="mt-6 text-center text-xs text-muted">Robotics Redefined.</p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
