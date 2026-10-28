'use client';

import { useRouter } from 'next/navigation';
import { Suspense, useEffect, type ReactNode } from 'react';
import { BrandMark } from '@/components/common/brand';
import { PasswordChangeGate } from '@/components/common/password-change-gate';
import { PortalShell } from '@/components/client/portal-shell';
import { ErrorState, LoadingBlock } from '@/components/ui/misc';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api';
import { MeProvider, useMeQuery } from '@/lib/auth';

/**
 * The client portal for customer organizations' users: their robots, missions, reports and team. Requires a session.
 * Arnobot staff may sign in too, as a preview of what customers see.
 */
export default function PortalLayout({ children }: { children: ReactNode }) {
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
  if (me.data.must_change_password) return <PasswordChangeGate me={me.data} />;

  return (
    <MeProvider me={me.data}>
      <PortalShell>
        <Suspense fallback={<LoadingBlock rows={8} />}>{children}</Suspense>
      </PortalShell>
    </MeProvider>
  );
}
