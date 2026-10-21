import type { PoolClient } from 'pg';

export interface NewJob {
  tenantId: string;
  /** e.g. "payslip.generate", "export.run", "notification.send" */
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  payloadVersion?: number;
  /** Same key => same job. Make it derive from the business fact (e.g. `payslip:${runId}:${employeeId}`). */
  idempotencyKey: string;
  correlationId?: string;
  /** Delay start; default now. */
  availableAt?: Date;
  maxAttempts?: number;
}

export interface Job {
  id: string;
  tenantId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  payloadVersion: number;
  attempts: number;
  maxAttempts: number;
  correlationId: string | null;
}

export type FailOutcome = 'retry_scheduled' | 'dead_lettered' | 'not_claimed';

/** Transport-neutral port. Today: Postgres outbox. Tomorrow: SQS/BullMQ adapter, same interface. */
export interface JobQueue {
  claim(limit: number, worker: string, leaseSeconds?: number): Promise<Job[]>;
  complete(job: Job, worker: string): Promise<boolean>;
  fail(job: Job, worker: string, error: { code: string; message: string }, permanent?: boolean): Promise<FailOutcome>;
}

/** Producers enqueue INSIDE the business transaction so the job exists iff the change committed. */
export interface JobProducer {
  enqueue(client: PoolClient, job: NewJob): Promise<{ id: string; created: boolean }>;
}

/** Throw from a handler when retrying cannot help (bad payload, missing entity, forbidden). */
export class PermanentJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
