import type { Pool } from 'pg';

/**
 * Enqueues the recurring per-tenant jobs. Everything is keyed by the tenant's own calendar date, so running
 * this every hour (or on several workers at once) creates each job exactly once.
 */
export async function scheduleDailyJobs(system: Pool): Promise<{ accrual: number; expiry: number }> {
  const accrual = await system.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
     SELECT t.id, 'tenants', t.id, 'leave.accrue', jsonb_build_object('asOf', d.day), 'leave-accrue:' || d.day
       FROM tenants t CROSS JOIN LATERAL (SELECT to_char((now() AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS day) d
      WHERE t.status IN ('trial', 'active')
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`);
  // The year-end lapse for last year runs through January (idempotent per employee and leave type).
  const expiry = await system.query(
    `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
     SELECT t.id, 'tenants', t.id, 'leave.expire', jsonb_build_object('year', d.year - 1), 'leave-expire:' || (d.year - 1)
       FROM tenants t CROSS JOIN LATERAL (SELECT extract(year FROM (now() AT TIME ZONE t.timezone))::int AS year, extract(month FROM (now() AT TIME ZONE t.timezone))::int AS month) d
      WHERE t.status IN ('trial', 'active') AND d.month = 1
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`);
  return { accrual: accrual.rowCount ?? 0, expiry: expiry.rowCount ?? 0 };
}
