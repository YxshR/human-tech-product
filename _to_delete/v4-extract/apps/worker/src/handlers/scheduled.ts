import { PermanentJobError } from '@humantech/jobs';
import { z } from 'zod';
import type { Register } from './types';

const accrue = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const expire = z.object({ year: z.number().int().min(2000).max(2100) });

/** Leave automation. The SQL functions are idempotent per employee/type/period, so re-running a job never double-grants. */
export const registerScheduled: Register = (runner) => runner
  .register('leave.accrue', async (job, ctx) => {
    const p = accrue.safeParse(job.payload);
    if (!p.success) throw new PermanentJobError('invalid_payload', 'asOf must be YYYY-MM-DD');
    const n = await ctx.tx(async (c) => (await c.query<{ n: number }>('SELECT app.accrue_leave($1::date) AS n', [p.data.asOf])).rows[0]!.n, { reason: 'scheduled leave accrual' });
    ctx.log('leave accrued', { asOf: p.data.asOf, granted: n });
  })
  .register('leave.expire', async (job, ctx) => {
    const p = expire.safeParse(job.payload);
    if (!p.success) throw new PermanentJobError('invalid_payload', 'year is invalid');
    const n = await ctx.tx(async (c) => (await c.query<{ n: number }>('SELECT app.expire_leave($1) AS n', [p.data.year])).rows[0]!.n, { reason: 'year-end leave lapse' });
    ctx.log('leave expired', { year: p.data.year, lapsed: n });
  });
