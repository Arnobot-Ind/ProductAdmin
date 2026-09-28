/**
 * Thin client for backend/ (docs/api.md). Same-origin `/api/v1` (proxied by next.config rewrites),
 * so the httpOnly session cookie is sent automatically. Never add secrets or tokens here.
 */
import type { ApiErrorBody } from '@arnobot/message-schema';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

let redirecting = false;
function handleUnauthenticated(): void {
  if (typeof window === 'undefined' || redirecting) return;
  if (window.location.pathname.startsWith('/login')) return;
  redirecting = true;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.assign(`/login?next=${next}`);
}

async function request<T>(method: string, path: string, body?: unknown, init: { query?: Query; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // CSRF defence: the API requires this header on every non-GET request.
  if (method !== 'GET') headers['X-Requested-With'] = 'pms-admin';
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${qs(init.query)}`, { method, headers, body: payload, credentials: 'include', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the PMS API. Check that the backend is running.');
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (!res.ok) {
    const err = (json as ApiErrorBody | undefined)?.error;
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') handleUnauthenticated();
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? (res.statusText || 'Request failed'), err?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};

/** A same-origin download link. The API streams the file or redirects to a short-lived URL. */
export function downloadUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'validation_failed' && err.details && typeof err.details === 'object') {
      const first = firstValidationIssue(err.details);
      if (first) return `${err.message}: ${first}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

function firstValidationIssue(details: unknown): string | null {
  // zod treeifyError shape: { errors: string[], properties?: { field: { errors: [...] } } }
  const d = details as { errors?: string[]; properties?: Record<string, { errors?: string[] }> };
  if (d.properties) {
    for (const [k, v] of Object.entries(d.properties)) if (v?.errors?.length) return `${k}: ${v.errors[0]}`;
  }
  if (d.errors?.length) return d.errors[0];
  return null;
}
