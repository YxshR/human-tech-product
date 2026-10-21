import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { safeReturnTo } from '@/lib/pkce';
import { SESSION_COOKIE, tenantCookie } from '@/lib/session';

/**
 * Pages cannot set cookies while they render, so when the person has no (or a stale) company selected, they are sent
 * here once: we pick the company (the one they asked for if it is theirs, else the first) and send them back.
 */
export async function GET(req: NextRequest) {
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'));
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const login = () => { const u = new URL('/auth/login', env('APP_URL')); u.searchParams.set('returnTo', returnTo); return NextResponse.redirect(u); };
  if (!token) return login();
  const res = await fetch(`${env('API_URL').replace(/\/$/, '')}/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store' }).catch(() => null);
  if (!res) return NextResponse.redirect(new URL('/dashboard', env('APP_URL')));
  if (res.status === 401) return NextResponse.redirect(new URL(`/auth/refresh?returnTo=${encodeURIComponent(returnTo)}`, env('APP_URL')));
  const me = (await res.json().catch(() => null)) as { data?: { companies?: Array<{ id: string }> } } | null;
  const companies = me?.data?.companies ?? [];
  const pick = companies.find((c) => c.id === req.nextUrl.searchParams.get('id')) ?? companies[0];
  const out = NextResponse.redirect(new URL(returnTo, env('APP_URL')));
  // 'none' remembers (for a day) that there is no company yet, so the middleware does not loop; the layout explains it.
  out.cookies.set(pick ? tenantCookie(pick.id) : { ...tenantCookie('none'), maxAge: 86400 });
  return out;
}
