import type { Pool, PoolClient } from 'pg';
import { FailOutcome, Job, JobProducer, JobQueue, NewJob } from './types';

interface Row {
  id: string; tenant_id: string; event_type: string; aggregate_type: string; aggregate_id: string;
  payload: Record<string, unknown>; payload_version: number; attempts: number; max_attempts: number; correlation_id: string | null;
}
const toJob = (r: Row): Job => ({
  id: r.id, tenantId: r.tenant_id, type: r.event_type, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
  payload: r.payload, payloadVersion: r.payload_version, attempts: r.attempts, maxAttempts: r.max_attempts, correlationId: r.correlation_id,
});

export class PostgresJobProducer implements JobProducer {
  async enqueue(client: PoolClient, job: NewJob): Promise<{ id: string; created: boolean }> {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload_version, payload, correlation_id,
                                  idempotency_key, available_at, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, now()),COALESCE($10, 5))
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [job.tenantId, job.aggregateType, job.aggregateId, job.type, job.payloadVersion ?? 1, JSON.stringify(job.payload ?? {}),
        job.correlationId ?? null, job.idempotencyKey, job.availableAt ?? null, job.maxAttempts ?? null],
    );
    if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM outbox_events WHERE tenant_id=$1 AND idempotency_key=$2', [job.tenantId, job.idempotencyKey]);
    return { id: existing.rows[0]!.id, created: false };
  }
}

/** Consumer side. Needs the SYSTEM role pool (the only role allowed to claim). */
export class PostgresJobQueue implements JobQueue {
  constructor(private readonly systemPool: Pool) {}

  async claim(limit: number, worker: string, leaseSeconds = 300): Promise<Job[]> {
    const { rows } = await this.systemPool.query<Row>(
      'SELECT * FROM app.claim_outbox_events($1, $2, make_interval(secs => $3))', [limit, worker, leaseSeconds]);
    return rows.map(toJob);
  }
  async complete(job: Job, worker: string): Promise<boolean> {
    const { rows } = await this.systemPool.query<{ ok: boolean }>('SELECT app.complete_outbox_event($1,$2) AS ok', [job.id, worker]);
    return rows[0]!.ok;
  }
  async fail(job: Job, worker: string, error: { code: string; message: string }, permanent = false): Promise<FailOutcome> {
    const { rows } = await this.systemPool.query<{ r: FailOutcome }>(
      'SELECT app.fail_outbox_event($1,$2,$3,$4,$5) AS r', [job.id, worker, error.code, error.message, permanent]);
    return rows[0]!.r;
  }
}
