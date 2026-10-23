import { NextRequest, NextResponse } from 'next/server';
import { devIssuer, devJwks, devLoginEnabled, isDevAccount, signDevToken } from '@/lib/dev-login';

/** Developer-only OpenID endpoints so the API can verify the developer sign-in. 404 in production. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!devLoginEnabled()) return new NextResponse(null, { status: 404 });
  const path = (await ctx.params).path.join('/');
  const noStore = { 'Cache-Control': 'no-store' };
  if (path === '.well-known/openid-configuration') {
    const i = devIssuer();
    return NextResponse.json({ issuer: i, authorization_endpoint: `${i}/authorize`, token_endpoint: `${i}/token`, jwks_uri: `${i}/.well-known/jwks.json` }, { headers: noStore });
  }
  if (path === '.well-known/jwks.json') return NextResponse.json(await devJwks(), { headers: noStore });
  // For the demo-data script, which has no browser.
  if (path === 'token') {
    const email = req.nextUrl.searchParams.get('email') ?? '';
    return isDevAccount(email) ? NextResponse.json(await signDevToken(email), { headers: noStore }) : NextResponse.json({ error: 'unknown account' }, { status: 404 });
  }
  return new NextResponse(null, { status: 404 });
}
