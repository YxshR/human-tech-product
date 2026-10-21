import { cookies } from 'next/headers';
import { isProd } from './env';

export const SESSION_COOKIE = 'ht_session';
export const TENANT_COOKIE = 'ht_tenant';
const base = () => ({ httpOnly: true, secure: isProd(), sameSite: 'lax' as const, path: '/' });

export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}
export async function getTenantId(): Promise<string | undefined> {
  return (await cookies()).get(TENANT_COOKIE)?.value;
}
export const sessionCookie = (token: string, maxAgeSec: number) => ({ name: SESSION_COOKIE, value: token, ...base(), maxAge: maxAgeSec });
export const tenantCookie = (id: string) => ({ name: TENANT_COOKIE, value: id, ...base(), maxAge: 60 * 60 * 24 * 30 });
