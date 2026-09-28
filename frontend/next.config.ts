import path from 'node:path';
import type { NextConfig } from 'next';

const apiInternal = (process.env.API_INTERNAL_URL || 'http://localhost:4000').replace(/\/$/, '');
// Parent folder, so Turbopack can compile the shared contract in ../backend/src/shared.
const repoRoot = path.join(__dirname, '..');
const wsOrigin = new URL(process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000');
const isDev = process.env.NODE_ENV !== 'production';

// Allow-list CSP. Inline scripts are needed for Next.js hydration + the no-flash theme script
// (nonce-based CSP via middleware is a listed improvement). Only the origins the panel really uses.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  `connect-src 'self' ${wsOrigin.origin} ${wsOrigin.origin.replace(/^http/, 'ws')} https://tile.openstreetmap.org`,
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  env: {
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000',
  },
  // Browser → same-origin /api/v1 → proxied to the backend, so the session cookie is first-party.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiInternal}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
