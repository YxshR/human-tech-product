import { type KeyObject, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { SignJWT, decodeJwt, jwtVerify, type JWK } from 'jose';
import { TokenVerifier, VerifiedToken } from './verifier';

/**
 * Sign-in with e-mail + password, for people who have no work account at the identity provider.
 * The API checks the password itself and signs a session token with its OWN key. By default that key is derived from
 * FILE_SIGNING_SECRET, so the feature works on every deployment with no extra setting; LOCAL_AUTH_PRIVATE_KEY replaces
 * it with a key of your own, and PASSWORD_LOGIN=off switches the feature off.
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
export interface LocalAuthOptions {
  /** `false` switches password sign-in off altogether. */
  enabled?: boolean;
  /** JSON of an RSA private key (JWK). Takes precedence over the derived key. */
  privateJwk?: string;
  /** A long deployment secret. An Ed25519 signing key is derived from it, the same on every instance and restart. */
  secret?: string;
}

/** PKCS#8 wrapper for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function derivedKey(secret: string): KeyObject {
  // HKDF with its own label: knowing this key says nothing about the secret, or about anything else derived from it.
  const seed = Buffer.from(hkdfSync('sha256', secret, 'humantech', 'password-session-signing-key-v1', 32));
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export class LocalAuth {
  private constructor(readonly issuer: string, private readonly audience: string, private readonly keys: { alg: 'RS256' | 'EdDSA'; priv: KeyObject; pub: KeyObject; kid: string } | null) {}

  static async create(issuer: string, audience: string, o: LocalAuthOptions = {}): Promise<LocalAuth> {
    if (o.enabled === false || (!o.privateJwk && !o.secret)) return new LocalAuth(issuer, audience, null);
    let priv: KeyObject; let alg: 'RS256' | 'EdDSA';
    if (o.privateJwk) {
      let jwk: JWK;
      try { jwk = JSON.parse(o.privateJwk) as JWK; } catch { throw new Error('Invalid configuration: LOCAL_AUTH_PRIVATE_KEY must be the JSON of an RSA private key (JWK)'); }
      if (jwk.kty !== 'RSA' || !jwk.d) throw new Error('Invalid configuration: LOCAL_AUTH_PRIVATE_KEY must be an RSA private key (JWK)');
      priv = createPrivateKey({ key: jwk as never, format: 'jwk' }); alg = 'RS256';
    } else {
      priv = derivedKey(o.secret!); alg = 'EdDSA';
    }
    const pub = createPublicKey(priv);
    const kid = createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('base64url').slice(0, 16);
    return new LocalAuth(issuer, audience, { alg, priv, pub, kid });
  }

  get enabled(): boolean { return this.keys !== null; }

  async sign(u: { subject: string; email: string; name: string }): Promise<{ token: string; expiresIn: number }> {
    if (!this.keys) throw new Error('password sign-in is not configured');
    const token = await new SignJWT({ email: u.email, email_verified: false, name: u.name, amr: ['pwd'] })
      .setProtectedHeader({ alg: this.keys.alg, kid: this.keys.kid }).setIssuer(this.issuer).setAudience(this.audience)
      .setSubject(u.subject).setIssuedAt().setExpirationTime(`${SESSION_SECONDS}s`).sign(this.keys.priv);
    return { token, expiresIn: SESSION_SECONDS };
  }

  /** Tokens we issued are checked against our key; every other token goes to the identity provider's verifier. */
  wrap(oidc: TokenVerifier): TokenVerifier {
    const keys = this.keys; const issuer = this.issuer; const audience = this.audience;
    if (!keys) return oidc;
    return {
      async verify(token: string): Promise<VerifiedToken> {
        let iss: unknown;
        try { iss = decodeJwt(token).iss; } catch { throw new Error('malformed token'); }
        if (iss !== issuer) return oidc.verify(token);
        const { payload } = await jwtVerify(token, keys.pub, { issuer, audience, algorithms: [keys.alg], clockTolerance: 5 });
        const email = typeof payload.email === 'string' ? payload.email : '';
        if (!payload.sub || !payload.sub.startsWith('local:') || !email) throw new Error('not a password session');
        // A password alone is one factor: these sessions never count as multi-factor.
        return { subject: payload.sub, email, emailVerified: false, name: typeof payload.name === 'string' && payload.name ? payload.name : email, mfa: false };
      },
    };
  }
}
