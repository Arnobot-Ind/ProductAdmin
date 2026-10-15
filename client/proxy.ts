import { NextResponse, type NextRequest } from 'next/server';

/**
 * Marks every API call that goes through this app (fetch, <img src>, download links) as the client portal's, so the
 * backend uses the portal's own session cookie (pms_client_session) and an admin-panel sign-in on the same host
 * never replaces it. Runs before the /api/v1 rewrite in next.config.ts, which forwards the header to the backend.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-pms-app', 'client');
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: '/api/v1/:path*' };
