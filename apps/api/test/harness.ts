import { INestApplication } from '@nestjs/common';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { OidcTokenVerifier } from '../src/auth/verifier';

export const ISSUER = 'https://idp.test';
export const AUDIENCE = 'humantech-api';

export interface Harness {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  token: (sub: string, opts?: { email?: string; mfa?: boolean; aud?: string; iss?: string; expSec?: number; name?: string }) => Promise<string>;
  close: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', use: 'sig', kid: 'k1' };
  const verifier = new OidcTokenVerifier(ISSUER, AUDIENCE, createLocalJWKSet({ keys: [jwk] }));
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_APP_URL!, OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, DATABASE_POOL_MAX: '5',
  });
  const app = await createApp(config, verifier);
  await app.init();
  return {
    app,
    http: () => request(app.getHttpServer()),
    token: async (sub, o = {}) =>
      new SignJWT({ email: o.email ?? `${sub}@example.test`, email_verified: true, name: o.name ?? sub, ...(o.mfa ? { amr: ['pwd', 'mfa'] } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject(sub).setIssuer(o.iss ?? ISSUER).setAudience(o.aud ?? AUDIENCE)
        .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + (o.expSec ?? 600))
        .sign(privateKey),
    close: () => app.close(),
  };
}
