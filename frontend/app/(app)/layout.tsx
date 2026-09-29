'use client';

import { useRouter } from 'next/navigation';
import { Suspense, useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/domain/app-shell';
import { BrandMark } from '@/components/domain/brand';
import { PasswordChangeGate } from '@/components/domain/password-change-gate';
import { ErrorState, LoadingBlock } from '@/components/ui/misc';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api';
import { MeProvider, useMeQuery } from '@/lib/auth';
import { RealtimeProvider } from '@/lib/realtime';

/** Everything except /login: requires a session (GET /auth/me). */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const me = useMeQuery();
  const router = useRouter();
  const unauth = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (unauth) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      router.replace(`/login?next=${next}`);
    }
  }, [unauth, router]);

  if (me.isLoading || unauth) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4" role="status" aria-live="polite">
        <BrandMark />
        <Spinner className="size-6 text-muted" label="Loading" />
      </div>
    );
  }
  if (me.error || !me.data) {
    return (
      <main id="main" className="mx-auto max-w-lg px-4 py-20">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </main>
    );
  }

  // Temporary password: the API refuses everything else until it is changed.
  if (me.data.must_change_password) return <PasswordChangeGate me={me.data} />;

  return (
    <MeProvider me={me.data}>
      <RealtimeProvider>
        <AppShell>
          <Suspense fallback={<LoadingBlock rows={8} />}>{children}</Suspense>
        </AppShell>
      </RealtimeProvider>
    </MeProvider>
  );
}
