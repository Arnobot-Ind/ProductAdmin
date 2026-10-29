'use client';

import { ArrowLeft } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Pages opened inside the app in this tab, oldest first (query-only changes such as tabs are not separate pages). */
const visited: string[] = [];

/** Records a page visit; repeat calls for the same page do nothing. */
function track(pathname: string): void {
  const last = visited.length - 1;
  if (visited[last] === pathname) return;
  // Arriving at the page before the current one means the browser went back: forget the page we left.
  if (visited[last - 1] === pathname) visited.pop();
  else visited.push(pathname);
  if (visited.length > 100) visited.shift();
}

/** One level up from a page, for Back when there is no previous page in the app (opened from a link). */
function parentPage(pathname: string): string | null {
  if (pathname === '/') return null;
  const mission = /^\/robots\/([^/]+)\/missions\/[^/]+$/.exec(pathname);
  if (mission) return `/robots/${mission[1]}?tab=missions`;
  if (pathname.startsWith('/overview/')) return '/';
  const up = pathname.replace(/\/[^/]+$/, '') || '/';
  // Folders that are not pages themselves go to the dashboard.
  return up === '/admin' || up === '/overview' ? '/' : up;
}

/**
 * In-app Back: returns to the previous page opened in the app; when there is none (the page was opened from a link
 * or a bookmark), goes one level up instead, so it never leaves the app or returns to the sign-in page.
 */
export function BackButton({ className }: { className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [hasPrevious, setHasPrevious] = useState(false);

  useEffect(() => {
    track(pathname);
    setHasPrevious(visited.length > 1);
  }, [pathname]);

  const parent = parentPage(pathname);
  // Never on the home page; elsewhere only when there is somewhere to go.
  if (pathname === '/' || (!hasPrevious && !parent)) return null;

  const back = () => {
    if (visited.length > 1) {
      visited.pop();
      router.back();
    } else if (parent) router.push(parent);
  };
  return (
    <button
      type="button"
      onClick={back}
      title={hasPrevious ? 'Back to the previous page' : 'Up one level'}
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-surface-2', className)}
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back
    </button>
  );
}

/**
 * Back in the shell, under the logo (positioned by `className`). It takes no room in the page: it sets
 * `--back-clear` on <main> to how far a page heading must move right so it does not touch the button
 * (0 when the page's content already starts clear of it, e.g. on wide screens).
 */
export function ShellBack({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  useLayoutEffect(() => {
    const main = document.getElementById('main');
    const box = ref.current;
    if (!main || !box) return;
    const update = () => {
      const b = box.getBoundingClientRect();
      const left = main.getBoundingClientRect().left + parseFloat(getComputedStyle(main).paddingLeft);
      main.style.setProperty('--back-clear', `${b.width ? Math.max(0, Math.ceil(b.right + 16 - left)) : 0}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(box);
    ro.observe(main);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [pathname]);
  return (
    <div ref={ref} className={cn('absolute z-10 w-max', className)}>
      <BackButton />
    </div>
  );
}

/** A page heading (eyebrow or breadcrumb, title, description) that starts level with Back and moves right only as far as needed to clear it. */
export function BesideBack({ above, below, children, className }: { above?: ReactNode; below?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)} style={{ paddingLeft: 'var(--back-clear, 0px)' }}>
      {above && <div className="mb-1">{above}</div>}
      {children}
      {below}
    </div>
  );
}
