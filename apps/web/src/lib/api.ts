import 'server-only';
import { redirect } from 'next/navigation';
import { env } from './env';
import { getAccessToken, getTenantId } from './session';

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Array<{ path: string; message: string }>) {
    super(message);
  }
}

interface Opts { method?: string; body?: unknown; tenant?: boolean; query?: Record<string, string | undefined> }

/** Server-side API client. The browser never sees the access token or talks to the API directly. */
export async function api<T>(path: string, opts: Opts = {}): Promise<T> {
  const token = await getAccessToken();
  if (!token) redirect('/auth/login');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (opts.tenant !== false) {
    const t = await getTenantId();
    if (t) headers['X-Tenant-Id'] = t;
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const qs = opts.query ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v) as Array<[string, string]>).toString() : '';
  const res = await fetch(`${env('API_URL').replace(/\/$/, '')}${path}${qs}`, {
    method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: 'no-store',
  });
  if (res.status === 401) redirect('/auth/login');
  const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string; fields?: Array<{ path: string; message: string }> } } | null;
  if (!res.ok) throw new ApiFailure(res.status, json?.error?.code ?? 'internal_error', json?.error?.message ?? 'Request failed', json?.error?.fields);
  return json as T;
}
