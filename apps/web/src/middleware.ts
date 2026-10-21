import { NextRequest, NextResponse } from 'next/server';

/** Cheap gate: no session cookie => sign in. Real verification happens in the API on every call. */
export function middleware(req: NextRequest) {
  if (!req.cookies.get('ht_session')) {
    const url = new URL('/auth/login', req.url);
    url.searchParams.set('returnTo', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  // Signed in but no company chosen yet (first visit): a route handler picks one, because pages cannot set cookies.
  if (!req.cookies.get('ht_tenant')) {
    const url = new URL('/auth/company', req.url);
    url.searchParams.set('returnTo', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  // Lets server code send people back to where they were after a silent token refresh.
  const headers = new Headers(req.headers);
  headers.set('x-return-to', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}
export const config = { matcher: ['/((?!auth|_next|favicon.ico).*)'] };
