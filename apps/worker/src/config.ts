import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** humantech_app — tenant-scoped handler work. */
  DATABASE_URL: z.string().url(),
  /** humantech_system — queue claim/complete/fail, scrub and scheduling only. */
  DATABASE_SYSTEM_URL: z.string().url(),
  WORKER_ID: z.string().min(1).default(`worker-${process.pid}`),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_POLL_MS: z.coerce.number().int().min(50).max(60000).default(1000),
  /** How often the scheduler looks for recurring per-tenant work (leave accrual etc.). Re-runs are idempotent. */
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).max(86_400_000).default(3_600_000),
  /** smtp://user:pass@host:587 (or smtps://). Unset in development => e-mails are logged, not sent. */
  SMTP_URL: z.string().url().optional(),
  MAIL_FROM: z.string().min(3).default('humanTech <no-reply@humantech.local>'),
  /** Public web origin used to build links in e-mails. */
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().min(1).default('./.data/files'),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const p = schema.safeParse(env);
  if (!p.success) throw new Error(`Invalid configuration:\n${p.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  const c = p.data;
  if (c.DATABASE_URL === c.DATABASE_SYSTEM_URL) throw new Error('Invalid configuration: DATABASE_URL and DATABASE_SYSTEM_URL must use different roles');
  if (c.STORAGE_DRIVER === 's3' && !(c.S3_BUCKET && c.S3_ACCESS_KEY && c.S3_SECRET_KEY)) throw new Error('Invalid configuration: S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY are required when STORAGE_DRIVER=s3');
  if (c.NODE_ENV === 'production' && !c.SMTP_URL) throw new Error('Invalid configuration: SMTP_URL is required in production');
  return c;
}
