import { NextRequest, NextResponse } from 'next/server';
import { baseUrl } from '@/lib/config';
import { devLoginEnabled, isDevAccount } from '@/lib/dev-login';
import { authCall } from '@/lib/password-login';
import { safeReturnTo } from '@/lib/pkce';
import { AUTH_MSG_COOKIE, REFRESH_COOKIE, TENANT_COOKIE, authMsgCookie, sessionCookie } from '@/lib/session';

/** Sign in with e-mail + password. The password goes straight to the API, which checks it; this app never keeps it. */
export async function POST(req: NextRequest) {
  const base = baseUrl(req.nextUrl.origin);
  const fd = await req.formData();
  const email = String(fd.get('email') ?? '').trim().toLowerCase();
  const returnTo = safeReturnTo(String(fd.get('returnTo') ?? ''));
  // On a developer machine the demo accounts keep working from the same form.
  if (devLoginEnabled() && isDevAccount(email)) return NextResponse.redirect(new URL('/auth/dev', base), 307);
  const back = (message: string) => {
    const u = new URL('/login', base);
    if (returnTo !== '/dashboard') u.searchParams.set('returnTo', returnTo);
    const r = NextResponse.redirect(u, 303);
    r.cookies.set(authMsgCookie(message));
    return r;
  };
  const a = await authCall('/auth/password/login', { email, password: String(fd.get('password') ?? '') });
  if (!a.ok || !a.token) return back(a.message);
  const res = NextResponse.redirect(new URL(returnTo, base), 303);
  res.cookies.set(sessionCookie(a.token, a.expiresIn ?? 3600));
  res.cookies.delete(TENANT_COOKIE);                       // pick the company afresh for this account
  res.cookies.delete({ name: REFRESH_COOKIE, path: '/auth' });
  res.cookies.delete(AUTH_MSG_COOKIE);
  return res;
}
