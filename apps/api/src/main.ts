import { loadConfig } from './config';
import { createApp } from './bootstrap';
import { OidcTokenVerifier } from './auth/verifier';
import { LocalAuth } from './auth/local-auth';

async function main(): Promise<void> {
  const config = loadConfig();
  const local = await LocalAuth.create(config.LOCAL_AUTH_ISSUER, config.OIDC_AUDIENCE, { enabled: config.PASSWORD_LOGIN === 'on', privateJwk: config.LOCAL_AUTH_PRIVATE_KEY, secret: config.FILE_SIGNING_SECRET });
  const app = await createApp(config, OidcTokenVerifier.fromJwksUri(config.OIDC_ISSUER, config.OIDC_AUDIENCE, config.OIDC_JWKS_URI), local);
  await app.listen(config.PORT, '0.0.0.0');
}
main().catch((e) => { console.error(e); process.exit(1); });
