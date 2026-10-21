import { NextRequest, NextResponse } from 'next/server';

/** Cheap gate: no session cookie => sign in. Real verification happens in the API on every call. */
export function middleware(req: NextRequest) {
  if (!req.cookies.get('ht_session')) {
    const url = new URL('/auth/login', req.url);
    url.searchParams.set('returnTo', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
export const config = { matcher: ['/((?!auth|_next|favicon.ico).*)'] };
