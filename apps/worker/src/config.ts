import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** humantech_app — tenant-scoped handler work. */
  DATABASE_URL: z.string().url(),
  /** humantech_system — queue claim/complete/fail only. */
  DATABASE_SYSTEM_URL: z.string().url(),
  WORKER_ID: z.string().min(1).default(`worker-${process.pid}`),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_POLL_MS: z.coerce.number().int().min(50).max(60000).default(1000),
});
export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const p = schema.safeParse(env);
  if (!p.success) throw new Error(`Invalid configuration:\n${p.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  if (p.data.DATABASE_URL === p.data.DATABASE_SYSTEM_URL) throw new Error('Invalid configuration: DATABASE_URL and DATABASE_SYSTEM_URL must use different roles');
  return p.data;
}
