import { baseUrl } from '@/lib/config';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getAccessToken, getTenantId } from '@/lib/session';

/**
 * The browser never talks to the API. A download link in a page points here: we ask the API for a short-lived file link
 * (which checks the person's permission and logs the access), then stream the file back with the person's token.
 */
const LINKS: Record<string, (id: string) => string> = {
  doc: (id) => `/documents/${id}/download-link`,
  payslip: (id) => `/me/payslips/${id}/download-link`,
  'payslip-any': (id) => `/payroll/payslips/${id}/download-link`,
  export: (id) => `/exports/${id}/download-link`,
  import: (id) => `/imports/${id}/result`,
};
/** Files the API streams straight back (no short-lived link step). */
const DIRECT: Record<string, (id: string) => string> = { register: (id) => `/payroll/runs/${id}/register?format=csv` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_PATH = /^\/files\/[0-9a-f-]{36}\/download\?exp=\d{1,12}&sig=[A-Za-z0-9_-]{20,128}$/i;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await ctx.params;
  const link = LINKS[kind];
  const direct = DIRECT[kind];
  const token = await getAccessToken();
  if (!token) return NextResponse.redirect(new URL('/login', baseUrl(_req.nextUrl.origin)));
  if ((!link && !direct) || !UUID.test(id)) return new NextResponse('Not found', { status: 404 });
  const api = env('API_URL').replace(/\/$/, '');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const tenant = await getTenantId();
  if (tenant) headers['X-Tenant-Id'] = tenant;
  const passthrough = (f: Response) => {
    const out = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const h of ['content-type', 'content-disposition', 'content-length']) { const v = f.headers.get(h); if (v) out.set(h, v); }
    return new NextResponse(f.body, { status: 200, headers: out });
  };
  if (direct) {
    const d = await fetch(`${api}${direct(id)}`, { headers, cache: 'no-store' });
    if (d.status === 401) return NextResponse.redirect(new URL(`/auth/refresh?returnTo=${encodeURIComponent(_req.nextUrl.pathname)}`, baseUrl(_req.nextUrl.origin)));
    return d.ok && d.body ? passthrough(d) : new NextResponse(d.status === 403 ? 'You do not have access to this file.' : 'Not found', { status: d.status === 403 ? 403 : 404 });
  }
  const l = await fetch(`${api}${link!(id)}`, { headers, cache: 'no-store' });
  if (l.status === 401) return NextResponse.redirect(new URL(`/auth/refresh?returnTo=${encodeURIComponent(_req.nextUrl.pathname)}`, baseUrl(_req.nextUrl.origin)));
  if (!l.ok) return new NextResponse(l.status === 403 ? 'You do not have access to this file.' : l.status === 409 ? 'This file is not ready yet. Try again in a minute.' : 'Not found', { status: l.status === 403 || l.status === 409 ? l.status : 404 });
  const url = ((await l.json()) as { data?: { url?: string } }).data?.url ?? '';
  if (!FILE_PATH.test(url)) return new NextResponse('Not found', { status: 404 });
  const f = await fetch(`${api}${url}`, { headers, cache: 'no-store' });
  if (!f.ok || !f.body) return new NextResponse('This link has expired. Go back and open it again.', { status: 410 });
  return passthrough(f);
}
