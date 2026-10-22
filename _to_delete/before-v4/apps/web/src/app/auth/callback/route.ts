import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { discovery, redirectUri } from '@/lib/oidc';
import { safeReturnTo } from '@/lib/pkce';
import { refreshCookie, sessionCookie } from '@/lib/session';

export async function GET(req: NextRequest) {
  const raw = req.cookies.get('ht_oidc')?.value;
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const fail = () => NextResponse.redirect(new URL('/auth/login', env('APP_URL')));
  if (!raw || !code || !state) return fail();
  let saved: { state: string; verifier: string; returnTo: string };
  try { saved = JSON.parse(raw); } catch { return fail(); }
  if (saved.state !== state) return fail();

  const d = await discovery();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: env('OIDC_CLIENT_ID'), code_verifier: saved.verifier,
      ...(process.env.OIDC_CLIENT_SECRET ? { client_secret: process.env.OIDC_CLIENT_SECRET } : {}),
    }),
    cache: 'no-store',
  });
  if (!res.ok) return fail();
  const tok = (await res.json()) as { access_token?: string; id_token?: string; refresh_token?: string; expires_in?: number };
  // The API validates this token (audience = OIDC_AUDIENCE). Use the id_token when the IdP issues no API access token.
  const bearer = process.env.OIDC_USE_ID_TOKEN === 'true' ? tok.id_token : tok.access_token;
  if (!bearer) return fail();

  const out = NextResponse.redirect(new URL(safeReturnTo(saved.returnTo), env('APP_URL')));
  out.cookies.set(sessionCookie(bearer, Math.min(tok.expires_in ?? 3600, 8 * 3600)));
  if (tok.refresh_token) out.cookies.set(refreshCookie(tok.refresh_token));
  out.cookies.delete({ name: 'ht_oidc', path: '/auth' });
  return out;
}
