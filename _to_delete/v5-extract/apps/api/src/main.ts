import { loadConfig } from './config';
import { createApp } from './bootstrap';
import { OidcTokenVerifier } from './auth/verifier';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config, OidcTokenVerifier.fromJwksUri(config.OIDC_ISSUER, config.OIDC_AUDIENCE, config.OIDC_JWKS_URI));
  await app.listen(config.PORT, '0.0.0.0');
}
main().catch((e) => { console.error(e); process.exit(1); });
