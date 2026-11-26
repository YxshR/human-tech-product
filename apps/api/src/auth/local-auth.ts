import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { SignJWT, createLocalJWKSet, decodeJwt, exportJWK, importJWK, type JWK, type KeyLike } from 'jose';
import { OidcTokenVerifier, TokenVerifier, VerifiedToken } from './verifier';

/**
 * Sign-in with e-mail + password, for people who have no work account at the identity provider.
 * The API checks the password itself and signs a session token with its OWN key (LOCAL_AUTH_PRIVATE_KEY).
 * Those tokens carry a separate issuer, so they can never be confused with the identity provider's, and they never
 * claim a second factor: actions that need MFA stay closed to a password-only session.
 */
export const LOCAL_AUTH = Symbol('LOCAL_AUTH');
export const SESSION_SECONDS = 8 * 3600;

// ---- passwords --------------------------------------------------------------------------------------------------
const N = 32768, R = 8, P = 1, KEYLEN = 32;
const derive = (password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p)).catch(() => null);
  return !!got && got.length === want.length && timingSafeEqual(got, want);
}
/** Spends the same time as a real check, so an unknown e-mail cannot be told apart from a wrong password by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, Buffer.alloc(16, 1));
}

// ---- login codes ------------------------------------------------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I: read aloud and typed without mistakes
/** Ten characters, about 50 bits: far out of reach of guessing when five misses cancel the code. */
export const newLoginCode = (): string => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
/** The code only works together with the e-mail address it was issued for. */
export const loginCodeHash = (email: string, code: string): Buffer => createHash('sha256').update(`login-code:${email.toLowerCase()}:${code}`).digest();

// ---- session tokens ---------------------------------------------------------------------------------------------
export class LocalAuth {
  private constructor(readonly issuer: string, private readonly audience: string, private readonly key: KeyLike | Uint8Array | null, private readonly kid: string, private readonly inner: TokenVerifier | null) {}

  /** `privateJwk` is the JSON of an RSA private key in JWK form. Without it password sign-in is switched off. */
  static async create(issuer: string, audience: string, privateJwk?: string): Promise<LocalAuth> {
    if (!privateJwk) return new LocalAuth(issuer, audience, null, '', null);
    let jwk: JWK;
    try { jwk = JSON.parse(privateJwk) as JWK; } catch { throw new Error('Invalid configuration: LOCAL_AUTH_PRIVATE_KEY must be the JSON of an RSA private key (JWK)'); }
    if (jwk.kty !== 'RSA' || !jwk.d) throw new Error('Invalid configuration: LOCAL_AUTH_PRIVATE_KEY must be an RSA private key (JWK)');
    const key = await importJWK(jwk, 'RS256');
    const pub = await exportJWK(await importJWK({ kty: 'RSA', n: jwk.n, e: jwk.e }, 'RS256'));
    const kid = createHash('sha256').update(String(jwk.n)).digest('base64url').slice(0, 16);
    const inner = new OidcTokenVerifier(issuer, audience, createLocalJWKSet({ keys: [{ ...pub, kid, alg: 'RS256', use: 'sig' }] }));
    return new LocalAuth(issuer, audience, key, kid, inner);
  }

  get enabled(): boolean { return this.key !== null; }

  async sign(u: { subject: string; email: string; name: string }): Promise<{ token: string; expiresIn: number }> {
    if (!this.key) throw new Error('password sign-in is not configured');
    const token = await new SignJWT({ email: u.email, email_verified: false, name: u.name, amr: ['pwd'] })
      .setProtectedHeader({ alg: 'RS256', kid: this.kid }).setIssuer(this.issuer).setAudience(this.audience)
      .setSubject(u.subject).setIssuedAt().setExpirationTime(`${SESSION_SECONDS}s`).sign(this.key);
    return { token, expiresIn: SESSION_SECONDS };
  }

  /** Tokens we issued are checked against our key; every other token goes to the identity provider's verifier. */
  wrap(oidc: TokenVerifier): TokenVerifier {
    const local = this.inner; const issuer = this.issuer;
    if (!local) return oidc;
    return {
      async verify(token: string): Promise<VerifiedToken> {
        let iss: unknown;
        try { iss = decodeJwt(token).iss; } catch { throw new Error('malformed token'); }
        if (iss !== issuer) return oidc.verify(token);
        const v = await local.verify(token);
        if (!v.subject.startsWith('local:')) throw new Error('not a password session');
        return { ...v, mfa: false };
      },
    };
  }
}
