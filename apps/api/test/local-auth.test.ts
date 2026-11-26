import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalAuth } from '../src/auth/local-auth';

const ISS = 'humantech-password'; const AUD = 'humantech-api';
const SECRET = 'a-long-deployment-secret-0123456789abcdef';
const never = { verify: async () => { throw new Error('went to the identity provider'); } };
const user = { subject: 'local:6f183a6b-9975-45b6-a2af-90a3c8167de8', email: 'a@corp.test', name: 'A' };

describe('password session keys', () => {
  it('works with nothing but the deployment secret, and two instances agree', async () => {
    const one = await LocalAuth.create(ISS, AUD, { secret: SECRET });
    const two = await LocalAuth.create(ISS, AUD, { secret: SECRET });
    expect(one.enabled).toBe(true);
    const { token } = await one.sign(user);
    expect(await two.wrap(never).verify(token)).toMatchObject({ subject: user.subject, email: user.email, mfa: false, emailVerified: false });
  });
  it('a different secret, issuer or audience does not verify', async () => {
    const { token } = await (await LocalAuth.create(ISS, AUD, { secret: SECRET })).sign(user);
    await expect((await LocalAuth.create(ISS, AUD, { secret: SECRET + 'x' })).wrap(never).verify(token)).rejects.toThrow();
    await expect((await LocalAuth.create(ISS, 'other-api', { secret: SECRET })).wrap(never).verify(token)).rejects.toThrow();
    await expect((await LocalAuth.create('other-issuer', AUD, { secret: SECRET })).wrap(never).verify(token)).rejects.toThrow('went to the identity provider');
  });
  it('an RSA key of your own takes precedence, and its tokens are not accepted by the derived key', async () => {
    const jwk = JSON.stringify(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }));
    const rsa = await LocalAuth.create(ISS, AUD, { secret: SECRET, privateJwk: jwk });
    const { token } = await rsa.sign(user);
    expect((await rsa.wrap(never).verify(token)).subject).toBe(user.subject);
    await expect((await LocalAuth.create(ISS, AUD, { secret: SECRET })).wrap(never).verify(token)).rejects.toThrow();
    await expect(LocalAuth.create(ISS, AUD, { privateJwk: '{"kty":"EC"}' })).rejects.toThrow(/RSA private key/);
  });
  it('can be switched off, and is off without any key material', async () => {
    expect((await LocalAuth.create(ISS, AUD, { enabled: false, secret: SECRET })).enabled).toBe(false);
    expect((await LocalAuth.create(ISS, AUD, {})).enabled).toBe(false);
  });
  it('refuses a token that is not a password session subject', async () => {
    const a = await LocalAuth.create(ISS, AUD, { secret: SECRET });
    const { token } = await a.sign({ ...user, subject: 'google-oauth2|123' });
    await expect(a.wrap(never).verify(token)).rejects.toThrow('not a password session');
  });
});
