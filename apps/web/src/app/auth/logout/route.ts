import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { REFRESH_COOKIE, SESSION_COOKIE, TENANT_COOKIE } from '@/lib/session';

export async function POST() {
  const res = NextResponse.redirect(new URL('/auth/login', env('APP_URL')), 303);
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(TENANT_COOKIE);
  res.cookies.delete({ name: REFRESH_COOKIE, path: '/auth' });
  return res;
}
