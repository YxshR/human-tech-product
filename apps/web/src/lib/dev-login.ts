import 'server-only';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';

/**
 * DEVELOPER-ONLY sign-in built into the web app, so nothing else has to be running to log in locally.
 * It is switched on only when NODE_ENV is not "production" (and DEV_LOGIN is not "off"). In a production build every
 * function here reports "disabled" and the routes answer 404. The API trusts these tokens only if its OIDC_ISSUER points
 * at `${APP_URL}/dev-idp`, which `pnpm dev` arranges.
 */
export const devLoginEnabled = (): boolean => process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN !== 'off';
export const DEV_PASSWORD = (): string => process.env.DEV_LOGIN_PASSWORD ?? 'Demo@12345';
export const DEV_ACCOUNTS: Array<{ email: string; role: string }> = [
  { email: 'owner@demo.test', role: 'Company owner' }, { email: 'hr@demo.test', role: 'HR admin' }, { email: 'finance@demo.test', role: 'Finance & payroll' },
  { email: 'approver@demo.test', role: 'Payroll approver' }, { email: 'recruiter@demo.test', role: 'Recruiter' }, { email: 'manager@demo.test', role: 'Manager' }, { email: 'employee@demo.test', role: 'Employee' },
];
export const isDevAccount = (email: string): boolean => DEV_ACCOUNTS.some((a) => a.email === email);
export const devIssuer = (): string => `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/dev-idp`;

interface Stored { kid: string; privateJwk: JWK; publicJwk: JWK }
let cached: Promise<Stored> | null = null;
/** One key pair, kept in the OS temp folder so restarts (and the API's cached copy of the public key) stay valid. */
function keys(): Promise<Stored> {
  cached ??= (async () => {
    const file = process.env.DEV_LOGIN_KEY_FILE ?? join(tmpdir(), 'humantech-dev-login-key.json');
    if (existsSync(file)) { try { return JSON.parse(readFileSync(file, 'utf8')) as Stored; } catch { /* regenerate */ } }
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const s: Stored = { kid: `dev-${Date.now().toString(36)}`, privateJwk: await exportJWK(privateKey), publicJwk: await exportJWK(publicKey) };
    writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
    return s;
  })();
  return cached;
}
export async function devJwks(): Promise<{ keys: JWK[] }> {
  const k = await keys();
  return { keys: [{ ...k.publicJwk, kid: k.kid, alg: 'RS256', use: 'sig' }] };
}
export async function signDevToken(email: string): Promise<{ token: string; expiresIn: number }> {
  const k = await keys();
  const expiresIn = 8 * 3600;
  const token = await new SignJWT({ email, email_verified: true, name: email.split('@')[0], amr: ['pwd', 'mfa'] })
    .setProtectedHeader({ alg: 'RS256', kid: k.kid }).setIssuer(devIssuer()).setAudience(process.env.OIDC_AUDIENCE ?? 'humantech-api')
    .setSubject(`dev-${email}`).setIssuedAt().setExpirationTime(`${expiresIn}s`).sign(await importJWK(k.privateJwk, 'RS256'));
  return { token, expiresIn };
}
