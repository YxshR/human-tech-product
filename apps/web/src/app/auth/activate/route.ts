import { NextRequest, NextResponse } from 'next/server';
import { baseUrl } from '@/lib/config';
import { authCall } from '@/lib/password-login';
import { AUTH_MSG_COOKIE, REFRESH_COOKIE, authMsgCookie, sessionCookie, tenantCookie } from '@/lib/session';

/** First sign-in: e-mail + the login code from the company + a password the person chooses. Signs them in when it works. */
export async function POST(req: NextRequest) {
  const base = baseUrl(req.nextUrl.origin);
  const fd = await req.formData();
  const email = String(fd.get('email') ?? '').trim().toLowerCase();
  const code = String(fd.get('code') ?? '').trim();
  const password = String(fd.get('password') ?? '');
  const back = (message: string) => {
    const r = NextResponse.redirect(new URL('/activate', base), 303);
    r.cookies.set(authMsgCookie(message));
    return r;
  };
  if (password !== String(fd.get('confirm') ?? '')) return back('The two passwords are not the same. Type the same password in both boxes.');
  const a = await authCall('/auth/password/activate', { email, code, password });
  if (!a.ok || !a.token) return back(a.message);
  const res = NextResponse.redirect(new URL('/dashboard?ok=' + encodeURIComponent('Your password is set. Welcome!'), base), 303);
  res.cookies.set(sessionCookie(a.token, a.expiresIn ?? 3600));
  if (a.tenantId) res.cookies.set(tenantCookie(a.tenantId));
  res.cookies.delete({ name: REFRESH_COOKIE, path: '/auth' });
  res.cookies.delete(AUTH_MSG_COOKIE);
  return res;
}
