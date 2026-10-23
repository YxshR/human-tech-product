import type { Pool, PoolClient } from 'pg';
import { withContext } from '@humantech/database';
import { Job, JobQueue, PermanentJobError } from './types';

export interface HandlerContext {
  /** Runs `fn` in a transaction scoped to the job's tenant (RLS applies; no cross-tenant reach). */
  tx<T>(fn: (c: PoolClient) => Promise<T>, opts?: { userId?: string; reason?: string }): Promise<T>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Delete payload keys (one-time secrets) from the stored job once they are no longer needed. */
  scrub(keys: string[]): Promise<void>;
}
export type JobHandler = (job: Job, ctx: HandlerContext) => Promise<void>;

export interface RunnerOptions {
  queue: JobQueue;
  /** Runtime (humantech_app) pool used for tenant-scoped handler work. */
  appPool: Pool;
  workerId: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  logger?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly opts: RunnerOptions) {}

  register(type: string, handler: JobHandler): this {
    if (this.handlers.has(type)) throw new Error(`handler already registered for ${type}`);
    this.handlers.set(type, handler);
    return this;
  }

  private log(msg: string, extra?: Record<string, unknown>): void {
    (this.opts.logger ?? (() => undefined))(msg, extra);
  }

  /** Process at most one batch; returns how many jobs were handled. Used by the loop and by tests. */
  async runOnce(): Promise<number> {
    const free = (this.opts.concurrency ?? 4) - this.inFlight.size;
    if (free <= 0) return 0;
    const jobs = await this.opts.queue.claim(free, this.opts.workerId, this.opts.leaseSeconds);
    const work = jobs.map((job) => {
      const p = this.handle(job).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
      return p;
    });
    await Promise.all(work);
    return jobs.length;
  }

  private async handle(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    const ctx: HandlerContext = {
      tx: (fn, o) => withContext(this.opts.appPool, { tenantId: job.tenantId, userId: o?.userId, reason: o?.reason ?? `job ${job.type}` }, fn),
      log: (m, e) => this.log(m, { jobId: job.id, type: job.type, ...e }),
      scrub: async (keys) => { await this.opts.queue.scrub(job, this.opts.workerId, keys); },
    };
    try {
      if (!handler) throw new PermanentJobError('no_handler', `no handler registered for ${job.type}`);
      await handler(job, ctx);
      await this.opts.queue.complete(job, this.opts.workerId);
    } catch (err) {
      const permanent = err instanceof PermanentJobError;
      const code = permanent ? err.code : ((err as { code?: unknown }).code && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : 'handler_error');
      const outcome = await this.opts.queue.fail(job, this.opts.workerId, { code, message: (err as Error).message ?? String(err) }, permanent);
      this.log('job failed', { jobId: job.id, type: job.type, code, outcome, attempt: job.attempts });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.opts.pollIntervalMs ?? 1000;
    this.loop = (async () => {
      while (this.running) {
        let n = 0;
        try { n = await this.runOnce(); } catch (e) { this.log('poll error', { error: (e as Error).message }); }
        if (!this.running) break;
        if (n === 0) await new Promise<void>((r) => { this.wake = r; setTimeout(r, interval).unref(); });
      }
    })();
  }

  /** Stop claiming, let in-flight jobs finish (graceful shutdown for SIGTERM). */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
  }
}
