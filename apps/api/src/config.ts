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
  /** "id:base64key[,id:base64key...]" — the FIRST key encrypts, all keys decrypt (rotation). 32-byte keys, ids 1-255. */
  FIELD_ENCRYPTION_KEYS: z.string().regex(/^\d{1,3}:[A-Za-z0-9+/]{43}=(,\d{1,3}:[A-Za-z0-9+/]{43}=)*$/, 'expected "1:<base64 of 32 bytes>[,2:...]"'),
  /** base64 of 32 bytes; separate from the encryption keys. Used for duplicate detection of identifiers. */
  BLIND_INDEX_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'expected base64 of 32 bytes'),
  /** Signs short-lived download links. */
  FILE_SIGNING_SECRET: z.string().min(32),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.data/files'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().min(3).optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
});
export type AppConfig = z.infer<typeof schema>;

/** Fails fast at boot with ALL problems listed; never starts half-configured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  if (parsed.data.STORAGE_DRIVER === 's3' && !(parsed.data.S3_BUCKET && parsed.data.S3_ACCESS_KEY && parsed.data.S3_SECRET_KEY)) {
    throw new Error('Invalid configuration: STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.CORS_ORIGINS.includes('*')) {
    throw new Error('Invalid configuration: CORS_ORIGINS must not contain * in production');
  }
  return parsed.data;
}
