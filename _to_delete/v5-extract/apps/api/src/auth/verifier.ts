import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';

export interface VerifiedToken {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** True when the IdP asserts a second factor (amr contains mfa/otp/hwk). */
  mfa: boolean;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Provider-agnostic OIDC access/ID token validation: signature, issuer, audience, expiry. */
export class OidcTokenVerifier implements TokenVerifier {
  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    private readonly keys: JWTVerifyGetKey,
  ) {}

  static fromJwksUri(issuer: string, audience: string, jwksUri?: string): OidcTokenVerifier {
    const uri = new URL(jwksUri ?? `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`);
    return new OidcTokenVerifier(issuer, audience, createRemoteJWKSet(uri, { cooldownDuration: 30_000 }));
  }

  async verify(token: string): Promise<VerifiedToken> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'], // never HS*/none
      clockTolerance: 5,
    });
    if (!payload.sub) throw new Error('token has no subject');
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (!email) throw new Error('token has no email claim');
    const amr = Array.isArray(payload.amr) ? (payload.amr as unknown[]).map(String) : [];
    return {
      subject: payload.sub,
      email,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' && payload.name ? payload.name : email,
      mfa: amr.some((a) => ['mfa', 'otp', 'hwk', 'sms', 'swk'].includes(a)),
    };
  }
}
