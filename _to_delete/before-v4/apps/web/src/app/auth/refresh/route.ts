import { NextRequest, NextResponse } from 'next/server';
import { env, isProd } from '@/lib/env';
import { discovery } from '@/lib/oidc';
import { safeReturnTo } from '@/lib/pkce';
import { REFRESH_COOKIE, refreshCookie, sessionCookie } from '@/lib/session';

const GUARD = 'ht_rf';

/**
 * The API said the access token is no longer good. Trade the refresh token for a new one and go back where the person was.
 * A short guard cookie stops a loop if the API keeps refusing the new token as well.
 */
export async function GET(req: NextRequest) {
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'));
  const toLogin = () => {
    const u = new URL('/auth/login', env('APP_URL')); u.searchParams.set('returnTo', returnTo);
    const r = NextResponse.redirect(u); r.cookies.delete('ht_session'); return r;
  };
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  if (!refresh || req.cookies.get(GUARD)) return toLogin();
  try {
    const d = await discovery();
    const res = await fetch(d.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, cache: 'no-store',
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refresh, client_id: env('OIDC_CLIENT_ID'),
        ...(process.env.OIDC_CLIENT_SECRET ? { client_secret: process.env.OIDC_CLIENT_SECRET } : {}),
      }),
    });
    if (!res.ok) return toLogin();
    const tok = (await res.json()) as { access_token?: string; id_token?: string; refresh_token?: string; expires_in?: number };
    const bearer = process.env.OIDC_USE_ID_TOKEN === 'true' ? tok.id_token : tok.access_token;
    if (!bearer) return toLogin();
    const out = NextResponse.redirect(new URL(returnTo, env('APP_URL')));
    out.cookies.set(sessionCookie(bearer, Math.min(tok.expires_in ?? 3600, 8 * 3600)));
    out.cookies.set(refreshCookie(tok.refresh_token ?? refresh));   // providers that rotate hand out a new one
    out.cookies.set({ name: GUARD, value: '1', httpOnly: true, secure: isProd(), sameSite: 'lax', path: '/', maxAge: 20 });
    return out;
  } catch {
    return toLogin();
  }
}
