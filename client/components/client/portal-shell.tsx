'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/common/brand';
import { api } from '@/lib/api';
import { useCanAnywhere, useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme';

/**
 * The client view's frame (customer organizations, e.g. Adani): a top bar with the brand, the organization, and
 * the client destinations only — dashboard, robots (with their reports), team (Managers) and account. Nothing from the admin panel.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const canAnywhere = useCanAnywhere();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const nav = [
    // Dashboard matches exactly; every other destination also covers its sub-pages.
    { href: '/', label: 'Dashboard', active: pathname === '/' },
    { href: '/robots', label: 'Robots', active: pathname.startsWith('/robots') },
    ...(canAnywhere('user.invite') ? [{ href: '/team', label: 'Team', active: pathname.startsWith('/team') }] : []),
    { href: '/account', label: 'Account', active: pathname.startsWith('/account') },
  ];

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      qc.clear();
      window.location.assign('/login');
    }
  };

  const links = (cls: string) =>
    nav.map((n) => (
      <Link
        key={n.href}
        href={n.href}
        aria-current={n.active ? 'page' : undefined}
        className={cn(cls, n.active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-muted hover:bg-surface-2 hover:text-fg')}
      >
        {n.label}
      </Link>
    ));

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link href="/" className="flex shrink-0 items-center gap-3" aria-label="Dashboard">
            <BrandMark compact />
          </Link>
          <span className="hidden truncate border-l border-border pl-4 text-sm font-semibold sm:block">{me.organization.name}</span>
          <nav aria-label="Main" className="ml-auto hidden items-center gap-1 md:flex">
            {links('rounded-md px-3 py-1.5 text-sm')}
          </nav>
          <div className="ml-auto flex items-center gap-1 md:ml-2">
            <button type="button" onClick={toggle} className="rounded-md p-2 hover:bg-surface-2" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
              {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
            </button>
            <button type="button" onClick={() => void logout()} className="hidden items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg md:inline-flex">
              <LogOut className="size-4" aria-hidden />
              Sign out
            </button>
            <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-md p-2 hover:bg-surface-2 md:hidden" aria-expanded={open} aria-controls="portal-mobile-nav" aria-label="Menu">
              {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
            </button>
          </div>
        </div>
        {open && (
          <nav id="portal-mobile-nav" aria-label="Main" className="flex flex-col gap-1 border-t border-border px-4 py-3 md:hidden">
            <p className="px-3 pb-1 text-xs text-muted">{me.organization.name}</p>
            {links('rounded-md px-3 py-2 text-sm')}
            <button type="button" onClick={() => void logout()} className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-left text-sm text-muted hover:bg-surface-2">
              <LogOut className="size-4" aria-hidden />
              Sign out
            </button>
          </nav>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>
      <footer className="border-t border-border py-4 text-center text-xs text-muted">Arnobot Private Limited · {me.email}</footer>
    </div>
  );
}
