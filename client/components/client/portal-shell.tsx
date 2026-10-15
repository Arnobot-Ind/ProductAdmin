'use client';

import { CLIENT_FEATURES } from '@arnobot/message-schema';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Bot, ChevronDown, LayoutDashboard, LogOut, Menu, Moon, Package, Sun, UserRound, Users, X, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/common/brand';
import { api } from '@/lib/api';
import { useCanAnywhere, useFeature, useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme';

type NavItem = { href: string; label: string; icon: LucideIcon; active: boolean };

/** "Harshil Shah" → "HS"; falls back to the email's first letter. */
function initials(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? email).slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The client view's frame (customer organizations, e.g. Adani): a top bar with the brand and organization, the client
 * destinations as tabs — dashboard, robots (with their reports), events and software (when the organization has those
 * features), team (Managers) — and a user menu (account, sign out). Nothing from the admin panel.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const canAnywhere = useCanAnywhere();
  const has = useFeature();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const nav: NavItem[] = [
    // Dashboard matches exactly; every other destination also covers its sub-pages.
    { href: '/', label: 'Dashboard', icon: LayoutDashboard, active: pathname === '/' },
    { href: '/robots', label: 'Robots', icon: Bot, active: pathname.startsWith('/robots') },
    ...(has(CLIENT_FEATURES.eventsView) ? [{ href: '/events', label: 'Events', icon: Bell, active: pathname.startsWith('/events') }] : []),
    ...(has(CLIENT_FEATURES.softwareView) ? [{ href: '/software', label: 'Software', icon: Package, active: pathname.startsWith('/software') }] : []),
    ...(canAnywhere('user.invite') ? [{ href: '/team', label: 'Team', icon: Users, active: pathname.startsWith('/team') }] : []),
  ];
  const accountActive = pathname.startsWith('/account');
  const role = me.grants[0]?.role_name ?? null;

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      qc.clear();
      window.location.assign('/login');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
          {/* Brand + organization */}
          <Link href="/" className="flex min-w-0 shrink-0 items-center gap-3" aria-label={`${me.organization.name} dashboard`}>
            <BrandMark compact />
            <span className="hidden h-8 w-px bg-border sm:block" aria-hidden />
            <span className="hidden min-w-0 flex-col leading-tight sm:flex">
              <span className="max-w-[13rem] truncate text-sm font-semibold text-fg" title={me.organization.name}>
                {me.organization.name}
              </span>
              <span className="text-[0.625rem] font-semibold tracking-[0.18em] text-muted uppercase">Client portal</span>
            </span>
          </Link>

          {/* Main destinations as tabs, the active one underlined */}
          <nav aria-label="Main" className="ml-4 hidden h-full items-stretch gap-1 lg:flex">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.active ? 'page' : undefined}
                className={cn(
                  'relative inline-flex items-center gap-2 px-3 text-sm transition-colors',
                  'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full',
                  n.active ? 'font-semibold text-accent-text after:bg-accent' : 'text-muted hover:text-fg after:bg-transparent hover:after:bg-border',
                )}
              >
                <n.icon className="size-4" aria-hidden />
                {n.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggle}
              className="inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            >
              {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
            </button>
            <span className="hidden lg:block">
              <UserMenu name={me.name} email={me.email} role={role} accountActive={accountActive} onLogout={() => void logout()} />
            </span>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="inline-flex size-9 items-center justify-center rounded-md hover:bg-surface-2 lg:hidden"
              aria-expanded={open}
              aria-controls="portal-mobile-nav"
              aria-label={open ? 'Close menu' : 'Open menu'}
            >
              {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
            </button>
          </div>
        </div>

        {/* Small screens: one panel with the user, the destinations and sign out */}
        {open && (
          <div id="portal-mobile-nav" className="border-t border-border bg-surface lg:hidden">
            <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
              <div className="mb-2 flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5">
                <Avatar name={me.name} email={me.email} />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-sm font-semibold">{me.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {me.organization.name}
                    {role && <> · {role}</>}
                  </span>
                </span>
              </div>
              <nav aria-label="Main" className="flex flex-col gap-0.5">
                {[...nav, { href: '/account', label: 'Account', icon: UserRound, active: accountActive }].map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    aria-current={n.active ? 'page' : undefined}
                    className={cn(
                      'inline-flex items-center gap-3 rounded-md px-3 py-2.5 text-sm',
                      n.active ? 'bg-accent-soft font-semibold text-accent-text' : 'text-muted hover:bg-surface-2 hover:text-fg',
                    )}
                  >
                    <n.icon className="size-4" aria-hidden />
                    {n.label}
                  </Link>
                ))}
              </nav>
              <button
                type="button"
                onClick={() => void logout()}
                className="mt-1 inline-flex items-center gap-3 rounded-md border-t border-border px-3 py-2.5 text-left text-sm text-fault hover:bg-fault-bg"
              >
                <LogOut className="size-4" aria-hidden />
                Sign out
              </button>
            </div>
          </div>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>
      <footer className="border-t border-border py-4 text-center text-xs text-muted">Arnobot Private Limited · {me.email}</footer>
    </div>
  );
}

function Avatar({ name, email, size = 'md' }: { name: string; email: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-fg', size === 'sm' ? 'size-8 text-xs' : 'size-9 text-sm')}
      aria-hidden
    >
      {initials(name, email)}
    </span>
  );
}

/** Avatar button with a dropdown: who is signed in, Account, Sign out. Closes on outside click, Escape or navigation. */
function UserMenu({ name, email, role, accountActive, onLogout }: { name: string; email: string; role: string | null; accountActive: boolean; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn('inline-flex items-center gap-2 rounded-full py-1 pr-2 pl-1 hover:bg-surface-2', (open || accountActive) && 'bg-surface-2')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
      >
        <Avatar name={name} email={email} size="sm" />
        <span className="hidden max-w-[9rem] truncate text-sm font-medium xl:block">{name}</span>
        <ChevronDown className={cn('size-4 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Avatar name={name} email={email} />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold">{name}</span>
              <span className="block truncate text-xs text-muted">{email}</span>
              {role && <span className="mt-1 inline-block rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] font-semibold text-accent-text">{role}</span>}
            </span>
          </div>
          <div className="p-1.5">
            <Link
              href="/account"
              role="menuitem"
              className={cn('flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-surface-2', accountActive && 'font-semibold text-accent-text')}
            >
              <UserRound className="size-4" aria-hidden />
              Account
            </Link>
            <button type="button" role="menuitem" onClick={onLogout} className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-fault hover:bg-fault-bg">
              <LogOut className="size-4" aria-hidden />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
