import { createPool } from '@humantech/database';
import { JobRunner, PostgresJobQueue } from '@humantech/jobs';
import { loadConfig } from './config';
import { registerHandlers } from './handlers';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = createPool(cfg.DATABASE_URL, cfg.WORKER_CONCURRENCY + 2);
  const system = createPool(cfg.DATABASE_SYSTEM_URL, 3);
  const log = (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ level: 'info', msg, worker: cfg.WORKER_ID, ...extra }));
  const runner = registerHandlers(new JobRunner({
    queue: new PostgresJobQueue(system), appPool: app, workerId: cfg.WORKER_ID,
    concurrency: cfg.WORKER_CONCURRENCY, pollIntervalMs: cfg.WORKER_POLL_MS, logger: log,
  }));
  runner.start();
  log('worker started');
  const shutdown = async (sig: string): Promise<void> => {
    log('shutting down', { sig });
    await runner.stop();
    await Promise.all([app.end(), system.end()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
main().catch((e) => { console.error(e); process.exit(1); });
