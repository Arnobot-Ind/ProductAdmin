'use client';

import type { MeDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api } from './api';

const MeContext = createContext<MeDto | null>(null);

export function useMeQuery() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeDto>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

export function MeProvider({ me, children }: { me: MeDto; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): MeDto {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe() used outside the authenticated layout');
  return me;
}

/**
 * UI-only permission check against the user's platform-level permissions (MeDto.permissions).
 * It only hides controls; the API enforces can(user, action, target) on every request.
 */
export function useCan(): (permission: string) => boolean {
  const me = useContext(MeContext);
  return (permission: string) => !!me?.permissions.includes(permission);
}

/**
 * Holds the permission in ANY scope (platform, organization or robot): a customer user's view of what they may do
 * on their own robots. UI only; per-robot answers come from the API (e.g. ArchiveSessionDetailDto.access).
 */
export function useCanAnywhere(): (permission: string) => boolean {
  const me = useContext(MeContext);
  // Falls back to platform permissions for a backend that predates scoped permissions.
  return (permission: string) => !!(me?.scoped_permissions ?? me?.permissions)?.includes(permission);
}

/** Signed in as a customer organization's user (e.g. Adani), not Arnobot staff. */
export function useIsCustomer(): boolean {
  return useContext(MeContext)?.organization?.kind === 'customer';
}
