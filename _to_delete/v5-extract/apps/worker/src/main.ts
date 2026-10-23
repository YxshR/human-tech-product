import { createPool } from '@humantech/database';
import { JobRunner, PostgresJobQueue } from '@humantech/jobs';
import { buildStorage } from '@humantech/storage';
import { loadConfig } from './config';
import { registerHandlers } from './registry';
import { LogMailer, SmtpMailer } from './mailer';
import { scheduleDailyJobs } from './scheduler';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = createPool(cfg.DATABASE_URL, cfg.WORKER_CONCURRENCY + 2);
  const system = createPool(cfg.DATABASE_SYSTEM_URL, 3);
  const log = (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ level: 'info', msg, worker: cfg.WORKER_ID, ...extra }));
  const storage = buildStorage(cfg.STORAGE_DRIVER === 's3'
    ? { driver: 's3', s3: { bucket: cfg.S3_BUCKET!, endpoint: cfg.S3_ENDPOINT, region: cfg.S3_REGION, accessKey: cfg.S3_ACCESS_KEY!, secretKey: cfg.S3_SECRET_KEY!, forcePathStyle: cfg.S3_FORCE_PATH_STYLE } }
    : { driver: 'local', localDir: cfg.STORAGE_LOCAL_DIR });
  const mailer = cfg.SMTP_URL ? new SmtpMailer(cfg.SMTP_URL, cfg.MAIL_FROM) : new LogMailer(log);
  const runner = registerHandlers(new JobRunner({
    queue: new PostgresJobQueue(system), appPool: app, workerId: cfg.WORKER_ID,
    concurrency: cfg.WORKER_CONCURRENCY, pollIntervalMs: cfg.WORKER_POLL_MS, logger: log,
  }), { mailer, storage, webBaseUrl: cfg.WEB_BASE_URL });
  runner.start();

  const tick = () => scheduleDailyJobs(system).then((r) => log('scheduler tick', r), (e: Error) => log('scheduler error', { error: e.message }));
  void tick();
  const timer = setInterval(() => void tick(), cfg.SCHEDULER_INTERVAL_MS);
  log('worker started');

  const shutdown = async (sig: string): Promise<void> => {
    log('shutting down', { sig });
    clearInterval(timer);
    await runner.stop();
    await Promise.all([app.end(), system.end()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
main().catch((e) => { console.error(e); process.exit(1); });
