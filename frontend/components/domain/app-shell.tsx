'use client';

import {
  Activity,
  AppWindow,
  ArrowUpRight,
  Bot,
  Building2,
  Boxes,
  Cpu,
  Download,
  Gauge,
  Grip,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Map as MapIcon,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Package,
  Route,
  ScrollText,
  Search,
  Server,
  Settings,
  Siren,
  ShieldCheck,
  Sun,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useCan, useCanAnywhere, useMe } from '@/lib/auth';
import { ShellBack } from '@/components/ui/back-button';
import { cn } from '@/lib/cn';
import { useRealtime } from '@/lib/realtime';
import { useTheme } from '@/lib/theme';
import { BrandMark } from './brand';
import { GlobalSearch } from './global-search';

interface NavItem {
  href: string;
  label: string;
  /** One line in the app menu: what the page is for. */
  description: string;
  Icon: typeof Bot;
  /** Platform-level permission needed to show the link (the API enforces regardless). */
  perm?: string;
  anyOf?: string[];
  /** Permission held in any scope (customers hold theirs on their organization). */
  scoped?: string;
}

interface NavGroup {
  id: string;
  section: string;
  Icon: typeof Bot;
  items: NavItem[];
}

/** Grouped by what people come to do: check the fleet, manage hardware and software, manage customers, run the platform. */
const NAV: NavGroup[] = [
  {
    id: 'overview',
    section: 'Overview',
    Icon: Gauge,
    items: [
      { href: '/', label: 'Dashboard', description: 'Key fleet numbers and the most urgent items', Icon: LayoutDashboard },
      { href: '/overview/attention', label: 'Needs attention', description: 'Faults, critical events, offline robots, warranties', Icon: Siren },
      { href: '/overview/map', label: 'Fleet map', description: 'Where every robot last reported its position', Icon: MapIcon },
      { href: '/overview/missions', label: 'Missions', description: 'Mission results across the fleet this week', Icon: Route },
      { href: '/overview/events', label: 'Events', description: 'The latest events from every robot', Icon: ListChecks },
    ],
  },
  {
    id: 'fleet',
    section: 'Fleet',
    Icon: Bot,
    items: [
      // Missions, events, videos and live status belong to one robot: they live on that robot's page.
      { href: '/robots', label: 'Robots', description: 'Every robot: live status, recordings, hardware and software', Icon: Bot },
      { href: '/downloads', label: 'Data export', description: 'Download video, GPS, IMU, LiDAR and encoder data', Icon: Download, scoped: 'data.download' },
    ],
  },
  {
    id: 'catalogue',
    section: 'Hardware & software',
    Icon: Cpu,
    items: [
      { href: '/products', label: 'Base models & attachments', description: 'UGV and UAV base models, attachments, hardware revisions and parts', Icon: Boxes, perm: 'catalog.read' },
      { href: '/releases', label: 'Software releases', description: 'Signed software and firmware versions for robots', Icon: Package, perm: 'catalog.read' },
      { href: '/admin/software', label: 'Client software', description: 'GCS, client portal and other software clients run', Icon: AppWindow, perm: 'org.manage' },
    ],
  },
  {
    id: 'access',
    section: 'Customers & access',
    Icon: Building2,
    items: [
      { href: '/admin/organizations', label: 'Organizations', description: 'Customers, their robots, contracts and settings', Icon: Building2, perm: 'org.manage' },
      { href: '/admin/users', label: 'Users', description: 'Invite people and manage their logins', Icon: Users, perm: 'user.manage' },
      { href: '/admin/access', label: 'Roles & permissions', description: 'What each role is allowed to see and do', Icon: ShieldCheck },
      { href: '/admin/audit', label: 'Audit log', description: 'Who signed in, viewed, changed or downloaded what', Icon: ScrollText, perm: 'audit.read' },
    ],
  },
  {
    id: 'system',
    section: 'System',
    Icon: Server,
    items: [
      { href: '/ingest', label: 'Ingest', description: 'Messages arriving from robots and the GCS', Icon: Inbox, anyOf: ['ingest.read', 'ingest.manage'] },
      { href: '/settings', label: 'Settings & status', description: 'Server health, storage and configuration', Icon: Settings, perm: 'system.read' },
      { href: '/account', label: 'My account', description: 'Your profile, password and permissions', Icon: UserCog },
    ],
  },
];

/**
 * Content width per page, chosen by what the page shows (first matching prefix wins; '/' only matches exactly):
 * many-column tables get the most room, small forms stay narrow so lines and fields are easy to read.
 */
const PAGE_WIDTHS: [prefix: string, cls: string][] = [
  // Small forms
  ['/account', 'max-w-4xl'],
  ['/robots/new', 'max-w-4xl'],
  // Tables with many columns
  ['/admin/users', 'max-w-[1760px]'],
  ['/admin/organizations', 'max-w-[1760px]'],
  ['/admin/audit', 'max-w-[1760px]'],
  ['/admin/software', 'max-w-[1760px]'],
  ['/ingest', 'max-w-[1760px]'],
  ['/releases', 'max-w-[1760px]'],
  // The fleet map uses the whole screen
  ['/overview/map', 'max-w-none'],
  // Tables, players, charts and maps
  ['/robots', 'max-w-screen-2xl'],
  ['/downloads', 'max-w-screen-2xl'],
  ['/products/', 'max-w-screen-2xl'],
  ['/attachments/', 'max-w-screen-2xl'],
  ['/videos', 'max-w-screen-2xl'],
  ['/overview/missions', 'max-w-screen-2xl'],
  ['/overview/events', 'max-w-screen-2xl'],
];
/** Cards and short lists: dashboard, needs attention, products list, roles, settings. */
const DEFAULT_WIDTH = 'max-w-7xl';

function pageWidth(pathname: string) {
  return PAGE_WIDTHS.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))?.[1] ?? DEFAULT_WIDTH;
}

/** Length of the menu's slide-in and slide-out animations (globals.css: app-menu-in / app-menu-out). */
const MENU_MS = 280;

/** Pages that belong to another menu entry (an attachment's page is under Base models & attachments). */
const MENU_ALIASES: [prefix: string, href: string][] = [['/attachments/', '/products']];

function isActive(pathname: string, href: string) {
  if (MENU_ALIASES.some(([prefix, to]) => to === href && pathname.startsWith(prefix))) return true;
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const me = useMe();
  const can = useCan();
  const canAnywhere = useCanAnywhere();
  const { connected } = useRealtime();
  const { theme, toggle } = useTheme();
  const qc = useQueryClient();
  const [menu, setMenu] = useState<'closed' | 'open' | 'closing'>('closed');
  /** The side menu on phones and tablets (a drawer); on large screens it is always there. */
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useSidebarCollapsed();

  const groups = useMemo(
    () =>
      NAV.map((g) => ({ ...g, items: g.items.filter((i) => (!i.perm || can(i.perm)) && (!i.anyOf || i.anyOf.some((p) => can(p))) && (!i.scoped || canAnywhere(i.scoped))) })).filter(
        (g) => g.items.length,
      ),
    [can, canAnywhere],
  );
  const current = groups.flatMap((g) => g.items).find((i) => isActive(pathname, i.href));

  const closeMenu = () => setMenu((m) => (m === 'open' ? 'closing' : m));
  useEffect(() => {
    if (menu !== 'closing') return;
    const t = window.setTimeout(() => setMenu('closed'), MENU_MS);
    return () => window.clearTimeout(t);
  }, [menu]);
  // Navigating closes the menu and the drawer.
  useEffect(() => {
    closeMenu();
    setDrawer(false);
  }, [pathname]);

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      qc.clear();
      window.location.assign('/login');
    }
  };

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only z-[70] rounded-md bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to main content
      </a>

      <header className="sticky top-0 z-30 border-b border-border bg-surface shadow-sm">
        <div className="flex h-16 w-full items-center gap-2 px-4 sm:gap-4 sm:px-6 lg:px-8">
          <Link href="/" aria-label="Arnobot PMS home" className="shrink-0">
            <BrandMark />
          </Link>
          {current && (
            <>
              <span className="hidden h-9 w-px bg-current opacity-30 2xl:block" aria-hidden />
              {/* Same size and style as "PMS / Product Admin" beside the logo. */}
              <span className="hidden min-w-0 items-center gap-2 text-sm font-semibold tracking-[0.16em] text-muted uppercase 2xl:inline-flex">
                <current.Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{current.label}</span>
              </span>
            </>
          )}
          {can('robot.details') && (
            <div className="ml-auto flex min-w-0 flex-1 justify-end xl:justify-center">
              <GlobalSearch />
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <span
              className={cn('hidden items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium sm:inline-flex', connected ? 'border-ok/40 text-ok' : 'border-warn/40 text-warn')}
              title={connected ? 'Receiving live updates' : 'Live connection down: refreshing every 15 s'}
            >
              <Activity className="size-3.5" aria-hidden />
              {connected ? 'Live' : 'Polling'}
            </span>
            <button type="button" onClick={toggle} className="rounded-md p-2 hover:bg-surface-2" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
              {theme === 'dark' ? <Sun className="size-5" aria-hidden /> : <Moon className="size-5" aria-hidden />}
            </button>
            <span className="hidden max-w-80 min-w-0 text-right text-sm leading-tight xl:block">
              <span className="block truncate font-semibold text-fg">{me.name}</span>
              <span className="block truncate text-muted">
                {me.email}{me.organization && <> · {me.organization.name}</>}
              </span>
            </span>
            <button type="button" onClick={logout} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm hover:bg-surface-2">
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
            {/* Phones and tablets: the side menu as a drawer (on large screens it is always shown). */}
            <button
              type="button"
              onClick={() => setDrawer(true)}
              aria-label="Open side menu"
              aria-expanded={drawer}
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2 lg:hidden"
            >
              <Menu className="size-6" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setMenu('open')}
              aria-label="Open menu"
              aria-haspopup="dialog"
              aria-expanded={menu === 'open'}
              className="ml-1 inline-flex size-11 items-center justify-center rounded-xl bg-accent text-accent-fg shadow-sm hover:opacity-90"
            >
              <Grip className="size-6" aria-hidden />
            </button>
          </div>
        </div>
      </header>

      {menu !== 'closed' && <AppMenu groups={groups} pathname={pathname} closing={menu === 'closing'} onClose={closeMenu} />}

      <div className="flex">
        {/* Large screens: the side menu is always there, under the logo (Back sits at its top). */}
        <aside
          aria-label="Side menu"
          className={cn('sticky top-16 hidden h-[calc(100dvh-4rem)] shrink-0 border-r border-border bg-surface/95 backdrop-blur lg:block', collapsed ? 'w-24' : 'w-64')}
        >
          <SideNav groups={groups} pathname={pathname} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
        </aside>

        <div className="relative min-w-0 flex-1">
          {/* Phones and tablets: Back under the logo (same left edge); page headings stay level with it and move right only if they would touch it. */}
          <ShellBack className="top-8 left-4 sm:left-6 lg:hidden" />
          <main id="main" tabIndex={-1} className={cn('mx-auto w-full px-4 py-8 outline-none sm:px-6 lg:px-8', pageWidth(pathname))}>
            {children}
          </main>
        </div>
      </div>

      {drawer && <SideDrawer groups={groups} pathname={pathname} onClose={() => setDrawer(false)} />}
    </div>
  );
}

const COLLAPSE_KEY = 'pms.sidebar.collapsed';
/** Whether the large-screen side menu shows icons only; remembered per browser. */
function useSidebarCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* storage unavailable: start expanded */
    }
  }, []);
  const set = (v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      /* not remembered */
    }
  };
  return [collapsed, set];
}

/** The side menu's content: Back at the top (under the logo), then every page by group. */
function SideNav({ groups, pathname, collapsed, onToggle, onNavigate }: { groups: NavGroup[]; pathname: string; collapsed?: boolean; onToggle?: () => void; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      {/* Back sits under the logo (same left edge) and level with the page heading (main's top padding). */}
      <div className={cn('flex min-h-14 items-center gap-2 pt-8 pr-3 pb-2', collapsed ? 'flex-col px-3' : 'pl-8')}>
        <ShellBack className="relative" />
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            title={collapsed ? 'Show the side menu' : 'Show icons only'}
            aria-label={collapsed ? 'Expand side menu' : 'Collapse side menu'}
            className="ml-auto inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
          >
            {collapsed ? <PanelLeftOpen className="size-5" aria-hidden /> : <PanelLeftClose className="size-5" aria-hidden />}
          </button>
        )}
      </div>
      <nav aria-label="Pages" className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`nav-${g.id}`} className="mt-4 first:mt-1">
            <h2 id={`nav-${g.id}`} className={cn('mb-1 px-3 text-xs font-semibold tracking-[0.12em] text-muted uppercase', collapsed && 'sr-only')}>
              {g.section}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((i) => {
                const active = isActive(pathname, i.href);
                return (
                  <li key={i.href}>
                    <Link
                      href={i.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? i.label : i.description}
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-base font-medium transition-colors',
                        collapsed && 'justify-center px-0',
                        active ? 'bg-accent text-accent-fg shadow-sm' : 'text-fg hover:bg-surface-2',
                      )}
                    >
                      <i.Icon className="size-5 shrink-0" aria-hidden />
                      <span className={cn('min-w-0 leading-tight', collapsed && 'sr-only')}>{i.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
    </div>
  );
}

/** Phones and tablets: the side menu slides in from the left. Esc, the close button or a tap outside closes it. */
function SideDrawer({ groups, pathname, onClose }: { groups: NavGroup[]; pathname: string; onClose: () => void }) {
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
      <div className="animate-drawer-in absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col bg-surface shadow-xl">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
          <BrandMark />
          <button type="button" onClick={onClose} aria-label="Close side menu" className="inline-flex size-10 items-center justify-center rounded-lg hover:bg-surface-2">
            <X className="size-6" aria-hidden />
          </button>
        </div>
        <nav aria-label="Pages" className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
          {groups.map((g) => (
            <section key={g.id} className="mt-4">
              <h2 className="mb-1 px-3 text-xs font-semibold tracking-[0.12em] text-muted uppercase">{g.section}</h2>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((i) => {
                  const active = isActive(pathname, i.href);
                  return (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        onClick={onClose}
                        aria-current={active ? 'page' : undefined}
                        className={cn('flex items-center gap-3 rounded-lg px-3 py-2.5 text-base font-medium', active ? 'bg-accent text-accent-fg' : 'hover:bg-surface-2')}
                      >
                        <i.Icon className="size-5 shrink-0" aria-hidden />
                        <span className="truncate">{i.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
      </div>
    </div>
  );
}

/**
 * Full-screen app menu (the 9-dot button): slides down from the top. Group tiles across the top, a search box,
 * then the chosen group's pages. Search looks through every page. Esc, the close button, picking a page or a click
 * on empty space (anything that is not a tile, link or the search box) closes it.
 */
function AppMenu({ groups, pathname, closing, onClose }: { groups: NavGroup[]; pathname: string; closing: boolean; onClose: () => void }) {
  const [groupId, setGroupId] = useState(() => (groups.find((g) => g.items.some((i) => isActive(pathname, i.href))) ?? groups[0]).id);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    // Lock page scrolling while open. Hiding the scrollbar would widen the page and nudge everything sideways,
    // so pad the body by exactly the scrollbar's width for as long as the menu is open.
    const { overflow, paddingRight } = document.body.style;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const matches = q
    ? groups.flatMap((g) => g.items.filter((i) => `${i.label} ${i.description} ${g.section}`.toLowerCase().includes(q)).map((i) => ({ ...i, section: g.section })))
    : null;
  const group = groups.find((g) => g.id === groupId) ?? groups[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="App menu"
      onClick={(e) => !(e.target as Element).closest('a, button, input, label') && onClose()}
      className={cn('fixed inset-0 z-50 overflow-y-auto bg-[#0b1430]/90 text-white backdrop-blur-md', closing ? 'animate-app-menu-out' : 'animate-app-menu-in')}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close menu"
        className="fixed top-0 right-0 z-10 inline-flex size-16 items-center justify-center bg-black/60 text-white hover:bg-black"
      >
        <X className="size-7" aria-hidden />
      </button>

      <div className="mx-auto w-full max-w-6xl px-6 pt-10 pb-16">
        {/* The menu is always dark, so always the white logo. */}
        <Image src="/brand/arnobot-logo-white.png" alt="Arnobot" width={1405} height={320} className="h-7 w-auto" />

        {/* Group tiles */}
        <ul className="mt-8 flex flex-wrap justify-center gap-x-4 gap-y-6">
          {groups.map((g) => {
            const selected = !matches && g.id === group.id;
            return (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => {
                    setGroupId(g.id);
                    setQuery('');
                  }}
                  aria-pressed={selected}
                  className="group flex w-32 flex-col items-center gap-2 text-center"
                >
                  <span
                    className={cn(
                      'flex size-16 items-center justify-center rounded-2xl transition-colors',
                      selected ? 'bg-accent text-accent-fg shadow-lg shadow-black/40' : 'bg-white/10 text-white group-hover:bg-white/20',
                    )}
                  >
                    <g.Icon className="size-8" aria-hidden />
                  </span>
                  <span className={cn('text-sm leading-tight font-medium', selected ? 'text-[#8fb0ff]' : 'text-white/75 group-hover:text-white')}>{g.section}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Search */}
        <label className="mx-auto mt-10 flex max-w-3xl items-center gap-3 border-b border-white/25 pb-2 focus-within:border-white/70">
          <span className="sr-only">Search pages</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search here…"
            className="w-full bg-transparent text-lg text-white placeholder:text-white/45 focus:outline-none"
          />
          <Search className="size-5 text-white/70" aria-hidden />
        </label>

        {/* Pages */}
        <section className="mt-10" aria-live="polite">
          <h2 className="border-b border-white/15 pb-3 text-2xl font-semibold">{matches ? `Results for “${query.trim()}”` : group.section}</h2>
          {matches && matches.length === 0 ? (
            <p className="mt-6 text-white/60">No page matches. Try another word.</p>
          ) : (
            <ul className="mt-4 grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {(matches ?? group.items).map((i) => {
                const active = isActive(pathname, i.href);
                return (
                  <li key={i.href}>
                    <Link
                      href={i.href}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      className={cn('flex items-start gap-3 rounded-xl px-3 py-3 hover:bg-white/10', active && 'bg-white/10')}
                    >
                      <ArrowUpRight className="mt-0.5 size-5 shrink-0 text-[#8fb0ff]" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-lg font-medium text-white">{i.label}</span>
                        <span className="block text-sm text-white/60">
                          {'section' in i ? `${i.section} · ` : ''}
                          {i.description}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
