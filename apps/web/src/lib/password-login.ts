import 'server-only';
import { env } from './env';

export interface AuthAnswer { ok: boolean; status: number; message: string; token?: string; expiresIn?: number; tenantId?: string }

/** Calls one of the API's public sign-in routes. Never throws: a failure comes back as a message for the person. */
export async function authCall(path: '/auth/password/login' | '/auth/password/activate', body: Record<string, string>): Promise<AuthAnswer> {
  let res: Response;
  try {
    res = await fetch(`${env('API_URL').replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, message: 'We could not reach the server. Please try again in a moment.' };
  }
  const json = (await res.json().catch(() => null)) as { data?: { token: string; expiresIn: number; tenantId?: string }; error?: { message: string; fields?: Array<{ path: string; message: string }> } } | null;
  if (res.ok && json?.data?.token) return { ok: true, status: res.status, message: '', ...json.data };
  if (res.status === 404) return { ok: false, status: 404, message: 'Signing in with a password is not switched on for this site. Use your work account, or ask your company administrator.' };
  if (res.status >= 500) return { ok: false, status: res.status, message: 'Something went wrong on our side. Please try again in a moment.' };
  const field = json?.error?.fields?.[0];
  return { ok: false, status: res.status, message: field && res.status === 422 ? `${field.path === 'password' ? 'Password' : field.path === 'code' ? 'Login code' : 'E-mail'}: ${field.message}.` : (json?.error?.message ?? 'That did not work. Please try again.') };
}
