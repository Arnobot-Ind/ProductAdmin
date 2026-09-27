'use client';

import {
  Activity,
  Bell,
  Bot,
  Boxes,
  Inbox,
  LayoutDashboard,
  LogOut,
  Map,
  Menu,
  Moon,
  Package,
  Sun,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useRealtime } from '@/lib/realtime';
import { useTheme } from '@/lib/theme';
import { BrandMark } from './brand';

interface NavItem {
  href: string;
  label: string;
  Icon: typeof Bot;
  /** Platform-level permission needed to show the link (the API enforces regardless). */
  perm?: string;
  anyOf?: string[];
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Fleet',
    items: [
      { href: '/', label: 'Dashboard', Icon: LayoutDashboard },
      { href: '/robots', label: 'Robots', Icon: Bot },
      { href: '/missions', label: 'Missions', Icon: Map },
      { href: '/events', label: 'Events', Icon: Bell },
    ],
  },
  {
    section: 'Catalogue',
    items: [
      { href: '/products', label: 'Products', Icon: Boxes, perm: 'catalog.read' },
      { href: '/releases', label: 'Releases', Icon: Package, perm: 'catalog.read' },
    ],
  },
  {
    section: 'Platform',
    items: [
      { href: '/ingest', label: 'Ingest', Icon: Inbox, anyOf: ['ingest.read', 'ingest.manage'] },
      { href: '/admin/users', label: 'Users & roles', Icon: Users, perm: 'user.manage' },
      { href: '/account', label: 'My account', Icon: UserCog },
    ],
  },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const me = useMe();
  const can = useCan();
  const { connected } = useRealtime();
  const { theme, toggle } = useTheme();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      qc.clear();
      window.location.assign('/login');
    }
  };

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-5 px-3 py-4">
      {NAV.map((group) => {
        const items = group.items.filter((i) => (!i.perm || can(i.perm)) && (!i.anyOf || i.anyOf.some((p) => can(p))));
        if (!items.length) return null;
        return (
          <div key={group.section}>
            <p className="eyebrow px-2 pb-1.5">{group.section}</p>
            <ul className="flex flex-col gap-0.5">
              {items.map((i) => {
                const active = isActive(pathname, i.href);
                return (
                  <li key={i.href}>
                    <Link
                      href={i.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-2 text-sm font-medium',
                        active ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-surface-2 hover:text-fg',
                      )}
                    >
                      <i.Icon className="size-4 shrink-0" aria-hidden />
                      {i.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only z-[70] rounded-md bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to main content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface lg:flex" aria-label="Sidebar">
        <div className="flex h-14 items-center border-b border-border px-4">
          <Link href="/" aria-label="Arnobot PMS home">
            <BrandMark />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-surface">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <BrandMark compact />
              <button type="button" onClick={() => setOpen(false)} aria-label="Close navigation" className="rounded-md p-1.5 hover:bg-surface-2">
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
          </div>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur">
          <button type="button" className="rounded-md p-1.5 hover:bg-surface-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
            <Menu className="size-5" aria-hidden />
          </button>
          <span className="lg:hidden">
            <BrandMark compact />
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn('hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium sm:inline-flex', connected ? 'border-ok/40 text-ok' : 'border-warn/40 text-warn')}
              title={connected ? 'Receiving live updates' : 'Live connection down: refreshing every 15 s'}
            >
              <Activity className="size-3.5" aria-hidden />
              {connected ? 'Live' : 'Polling'}
            </span>
            <button type="button" onClick={toggle} className="rounded-md p-2 hover:bg-surface-2" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
              {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
            </button>
            <span className="hidden text-right text-xs leading-tight md:block">
              <span className="block font-semibold text-fg">{me.name}</span>
              <span className="block text-muted">{me.email}</span>
            </span>
            <button type="button" onClick={logout} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm hover:bg-surface-2">
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] px-4 py-6 outline-none sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
