import { Pool, PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RequestContext {
  /** Verified (membership-checked) tenant. NEVER taken straight from the browser. */
  tenantId?: string;
  userId?: string;
  /** Free-text reason recorded in history/audit rows written by DB triggers. */
  reason?: string;
  /** Business effective date for effective-dated history triggers (YYYY-MM-DD). */
  effectiveDate?: string;
}

/**
 * Runs `fn` inside ONE transaction on ONE connection with transaction-local context.
 * `set_config(..., true)` is cleared automatically at COMMIT/ROLLBACK, so a pooled
 * connection can never leak one request's tenant into the next (ADR-0005).
 */
export async function withContext<T>(
  pool: Pool,
  ctx: RequestContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (ctx.tenantId && !UUID_RE.test(ctx.tenantId)) throw new Error('invalid tenant id');
  if (ctx.userId && !UUID_RE.test(ctx.userId)) throw new Error('invalid user id');
  if (ctx.effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(ctx.effectiveDate)) {
    throw new Error('invalid effective date');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.change_reason', $3, true),
              set_config('app.effective_date', $4, true)`,
      [ctx.tenantId ?? '', ctx.userId ?? '', ctx.reason ?? '', ctx.effectiveDate ?? ''],
    );
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({ connectionString, max, application_name: 'humantech' });
}
