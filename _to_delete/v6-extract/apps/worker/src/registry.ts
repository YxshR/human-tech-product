import { JobRunner, PermanentJobError } from '@humantech/jobs';
import { z } from 'zod';
import { registerInvitation } from './handlers/invitation';
import { registerPayroll } from './handlers/payroll';
import { registerScheduled } from './handlers/scheduled';
import type { Deps } from './handlers/types';

export type { Deps };
const ping = z.object({ note: z.string().max(200).optional() });

/**
 * Register every job type here. Handlers must be idempotent (a job can run twice if a worker
 * crashes after finishing but before completing) and must validate their payload.
 */
export function registerHandlers(runner: JobRunner, deps: Deps): JobRunner {
  runner.register('system.ping', async (job, ctx) => {
    const parsed = ping.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError('invalid_payload', parsed.error.message);
    ctx.log('ping', { note: parsed.data.note ?? null });
  });
  registerInvitation(runner, deps);
  registerPayroll(runner, deps);
  registerScheduled(runner, deps);
  return runner;
}
