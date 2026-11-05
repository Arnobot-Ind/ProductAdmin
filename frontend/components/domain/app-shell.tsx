'use client';

import { ChevronDown, LogOut, Menu, Moon, Sun, UserCog, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShellBack } from '@/components/ui/back-button';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useTheme } from '@/lib/theme';
import { BrandMark } from './brand';
import { GlobalSearch } from './global-search';
import { NAV, visibleNav, type NavItem } from './nav';

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** The page frame: a slim top bar (logo, search, account), the side menu, and the page using all the width left. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const can = useCan();
  /** The side menu on phones and tablets (a drawer); on large screens it is always there. */
  const [drawer, setDrawer] = useState(false);
  const items = useMemo(() => visibleNav(NAV, can), [can]);

  // Navigating closes the drawer.
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only z-[70] rounded-md bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to main content
      </a>

      <header className="sticky top-0 z-30 border-b border-border bg-surface">
        <div className="flex h-14 w-full items-center gap-3 px-4">
          <button type="button" onClick={() => setDrawer(true)} aria-label="Open side menu" aria-expanded={drawer} className="-ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-surface-2 lg:hidden">
            <Menu className="size-5" aria-hidden />
          </button>
          <Link href="/" aria-label="Arnobot home" className="flex shrink-0 items-center lg:w-[calc(var(--spacing)*50)]">
            <BrandMark small />
          </Link>
          {can('robot.details') && <GlobalSearch />}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ThemeButton />
            <UserMenu />
          </div>
        </div>
      </header>

      <div className="flex">
        <aside aria-label="Side menu" className="sticky top-14 hidden h-[calc(100dvh-calc(var(--spacing)*14))] w-54 shrink-0 border-r border-border bg-surface lg:block">
          <SideNav items={items} pathname={pathname} />
        </aside>

        <div className="relative min-w-0 flex-1">
          {/* Phones and tablets: Back at the page's top left; page headings move right only if they would touch it. */}
          <ShellBack className="top-4 left-4 lg:hidden" />
          <main id="main" tabIndex={-1} className="w-full px-4 py-4 outline-none">
            {/* Each new page (a new path, not a filter or tab in the URL query) fades in smoothly. */}
            <div key={pathname} className="animate-page-in">
              {children}
            </div>
          </main>
        </div>
      </div>

      {drawer && <SideDrawer items={items} pathname={pathname} onClose={() => setDrawer(false)} />}
    </div>
  );
}

/** The signed-in person: name in the bar, everything else one click away. */
/** Switches between light and dark. The choice is remembered in this browser. */
function ThemeButton() {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button type="button" onClick={toggle} aria-label={label} title={label} className="inline-flex size-10 items-center justify-center rounded-md border border-border hover:bg-surface-2">
      {theme === 'dark' ? <Sun className="size-5" aria-hidden /> : <Moon className="size-5" aria-hidden />}
    </button>
  );
}

function UserMenu() {
  const me = useMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      qc.clear();
      window.location.assign('/login');
    }
  };

  const row = 'flex w-full items-center gap-2 px-3 py-2 text-left text-base hover:bg-surface-2';
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Account menu for ${me.name}`} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-base hover:bg-surface-2">
        <span className="max-w-24 truncate sm:max-w-48">{me.name}</span>
        <ChevronDown className="size-4 text-muted" aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-base font-medium">{me.name}</p>
            <p className="truncate text-sm text-muted">{me.email}</p>
          </div>
          <Link href="/account" onClick={() => setOpen(false)} className={row}>
            <UserCog className="size-4 text-muted" aria-hidden /> My account
          </Link>
          <button type="button" onClick={logout} className={cn(row, 'border-t border-border')}>
            <LogOut className="size-4 text-muted" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function NavLinks({ items, pathname, onNavigate }: { items: NavItem[]; pathname: string; onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((i) => {
        const active = isActive(pathname, i.href);
        return (
          <li key={i.href}>
            <Link
              href={i.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              title={i.description}
              className={cn('flex items-center gap-2.5 rounded-md px-3 py-2 text-base transition-colors', active ? 'bg-accent-soft font-medium text-accent-text' : 'text-muted hover:bg-surface-2 hover:text-fg')}
            >
              <i.Icon className="size-4.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{i.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The side menu's content: Back on inner pages, then the pages. */
function SideNav({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <div className="flex h-full flex-col px-2 py-3">
      <ShellBack className="relative mb-1" />
      <nav aria-label="Pages" className="min-h-0 flex-1 overflow-y-auto">
        <NavLinks items={items} pathname={pathname} />
      </nav>
    </div>
  );
}

/** Phones and tablets: the side menu slides in from the left. Esc, the close button or a tap outside closes it. */
function SideDrawer({ items, pathname, onClose }: { items: NavItem[]; pathname: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label="Side menu" className="fixed inset-0 z-50 lg:hidden">
      <button type="button" aria-label="Close side menu" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="animate-drawer-in absolute inset-y-0 left-0 flex w-[min(16rem,80vw)] flex-col bg-surface shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <BrandMark small />
          <button type="button" onClick={onClose} aria-label="Close side menu" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-surface-2">
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <nav aria-label="Pages" className="min-h-0 flex-1 overflow-y-auto p-2">
          <NavLinks items={items} pathname={pathname} onNavigate={onClose} />
        </nav>
      </div>
    </div>
  );
}
