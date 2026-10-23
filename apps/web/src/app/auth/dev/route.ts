import { NextRequest, NextResponse } from 'next/server';
import { baseUrl } from '@/lib/config';
import { env } from '@/lib/env';
import { DEV_PASSWORD, devLoginEnabled, isDevAccount, signDevToken } from '@/lib/dev-login';
import { safeReturnTo } from '@/lib/pkce';
import { REFRESH_COOKIE, TENANT_COOKIE, sessionCookie } from '@/lib/session';

/** Developer-only: sign in with an e-mail + password (or a one-click role button). 404 in production. */
export async function POST(req: NextRequest) {
  if (!devLoginEnabled()) return new NextResponse(null, { status: 404 });
  const base = baseUrl(req.nextUrl.origin);
  const fd = await req.formData();
  const quick = req.nextUrl.searchParams.get('quick') === '1';
  const email = String(fd.get(quick ? 'quickEmail' : 'email') ?? '').trim().toLowerCase();
  const returnTo = safeReturnTo(String(fd.get('returnTo') ?? ''));
  if (!isDevAccount(email) || (!quick && String(fd.get('password') ?? '') !== DEV_PASSWORD())) {
    return NextResponse.redirect(new URL(`/login?error=badcreds&returnTo=${encodeURIComponent(returnTo)}`, base), 303);
  }
  const { token, expiresIn } = await signDevToken(email);
  // Check the API accepts this token now, so a mismatch shows a clear message instead of bouncing back to this page.
  const probe = await fetch(`${env('API_URL').replace(/\/$/, '')}/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store' }).catch(() => null);
  if (!probe) return NextResponse.redirect(new URL(`/login?error=apidown&returnTo=${encodeURIComponent(returnTo)}`, base), 303);
  if (probe.status === 401) return NextResponse.redirect(new URL(`/login?error=apireject&returnTo=${encodeURIComponent(returnTo)}`, base), 303);
  const res = NextResponse.redirect(new URL(returnTo, base), 303);
  res.cookies.set(sessionCookie(token, expiresIn));
  res.cookies.delete(TENANT_COOKIE);                       // pick the company afresh for this account
  res.cookies.delete({ name: REFRESH_COOKIE, path: '/auth' });
  return res;
}
