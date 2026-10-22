import { NextRequest, NextResponse } from 'next/server';
import { baseUrl } from '@/lib/config';
import { REFRESH_COOKIE, SESSION_COOKIE, TENANT_COOKIE } from '@/lib/session';

export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL('/login', baseUrl(req.nextUrl.origin)), 303);
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(TENANT_COOKIE);
  res.cookies.delete({ name: REFRESH_COOKIE, path: '/auth' });
  return res;
}
