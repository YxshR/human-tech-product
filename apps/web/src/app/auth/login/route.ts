import { NextRequest, NextResponse } from 'next/server';
import { env, isProd } from '@/lib/env';
import { discovery, redirectUri } from '@/lib/oidc';
import { challengeFor, randomToken, safeReturnTo } from '@/lib/pkce';

export async function GET(req: NextRequest) {
  const d = await discovery();
  const state = randomToken(16);
  const verifier = randomToken(48);
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'));
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: env('OIDC_CLIENT_ID'), redirect_uri: redirectUri(), scope: process.env.OIDC_SCOPE ?? 'openid profile email',
    state, code_challenge: challengeFor(verifier), code_challenge_method: 'S256',
  }).toString();
  const res = NextResponse.redirect(url);
  const c = { httpOnly: true, secure: isProd(), sameSite: 'lax' as const, path: '/auth', maxAge: 600 };
  res.cookies.set('ht_oidc', JSON.stringify({ state, verifier, returnTo }), c);
  return res;
}
