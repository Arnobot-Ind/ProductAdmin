import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="eyebrow">404</p>
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-sm text-muted">The page you asked for does not exist.</p>
      <Link href="/robots" className="mt-2 text-accent-text underline">
        Back to the dashboard
      </Link>
    </main>
  );
}
