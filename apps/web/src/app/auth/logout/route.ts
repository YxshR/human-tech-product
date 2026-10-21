import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { SESSION_COOKIE, TENANT_COOKIE } from '@/lib/session';

export async function POST() {
  const res = NextResponse.redirect(new URL('/auth/login', env('APP_URL')), 303);
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(TENANT_COOKIE);
  return res;
}
