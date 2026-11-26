'use server';
import { api, ApiFailure } from './api';

export type LoginCodeState =
  | { ok: true; email: string; code: string; expiresAt: string; reset: boolean }
  | { ok: false; error: string }
  | null;

/**
 * Creates a login code (or, for someone who already has a login, a password-reset code) for one employee.
 * The code comes back to the page that asked and is shown once; it is never put in an address or stored by this app.
 */
export async function issueLoginCode(_prev: LoginCodeState, fd: FormData): Promise<LoginCodeState> {
  const employeeId = String(fd.get('employeeId') ?? '');
  const reset = fd.get('mode') === 'reset';
  const roleKeys = fd.getAll('roleKeys').map(String).filter(Boolean);
  try {
    const r = await api<{ data: { email: string; code: string; expiresAt: string } }>(reset ? '/access/password-resets' : '/access/login-codes', {
      method: 'POST',
      body: reset ? { employeeId } : { employeeId, email: String(fd.get('email') ?? '').trim(), ...(roleKeys.length ? { roleKeys } : {}) },
    });
    return { ok: true, email: r.data.email, code: r.data.code, expiresAt: r.data.expiresAt, reset };
  } catch (e) {
    if (e instanceof ApiFailure) {
      if (e.code === 'mfa_required') return { ok: false, error: 'This needs a sign-in with multi-factor authentication. Sign in with your work account and second factor, then try again.' };
      if (e.status === 403) return { ok: false, error: e.message || 'Your role does not allow this.' };
      if (e.status === 422) return { ok: false, error: e.fields?.some((f) => f.path === 'email') ? 'Enter a valid e-mail address.' : (e.fields?.[0]?.message ?? e.message) };
      if (e.status >= 500) return { ok: false, error: 'Something went wrong on our side and no code was created. Please try again.' };
      return { ok: false, error: e.message };
    }
    if (typeof (e as { digest?: unknown })?.digest === 'string' && (e as { digest: string }).digest.startsWith('NEXT_')) throw e;
    return { ok: false, error: 'We could not reach the server, so no code was created. Check your connection and try again.' };
  }
}
