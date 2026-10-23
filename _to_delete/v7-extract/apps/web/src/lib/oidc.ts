import { env } from './env';

interface Discovery { authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string }
let cached: { at: number; doc: Discovery } | null = null;

export async function discovery(): Promise<Discovery> {
  if (cached && Date.now() - cached.at < 3_600_000) return cached.doc;
  const issuer = env('OIDC_ISSUER').replace(/\/$/, '');
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { cache: 'no-store' });
  if (!res.ok) throw new Error('OIDC discovery failed');
  const doc = (await res.json()) as Discovery;
  cached = { at: Date.now(), doc };
  return doc;
}
export const redirectUri = () => `${env('APP_URL').replace(/\/$/, '')}/auth/callback`;
