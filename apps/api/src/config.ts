import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  /** Defaults to `${OIDC_ISSUER}/.well-known/jwks.json`. */
  OIDC_JWKS_URI: z.string().url().optional(),
  CORS_ORIGINS: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  BODY_LIMIT: z.string().default('100kb'),
});
export type AppConfig = z.infer<typeof schema>;

/** Fails fast at boot with ALL problems listed; never starts half-configured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.CORS_ORIGINS.includes('*')) {
    throw new Error('Invalid configuration: CORS_ORIGINS must not contain * in production');
  }
  return parsed.data;
}
