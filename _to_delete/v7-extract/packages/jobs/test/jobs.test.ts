import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, withContext } from '@humantech/database';
import { Job, JobRunner, PermanentJobError, PostgresJobProducer, PostgresJobQueue } from '../src';

let app: Pool, system: Pool, admin: Pool;
let tenantId: string, otherTenant: string, userId: string;
const producer = new PostgresJobProducer();
const queue = () => new PostgresJobQueue(system);
const enqueue = (type: string, over: Partial<Parameters<PostgresJobProducer['enqueue']>[1]> = {}, t = tenantId) =>
  withContext(app, { tenantId: t, userId }, (c) =>
    producer.enqueue(c, { tenantId: t, type, aggregateType: 'test', aggregateId: randomUUID(), idempotencyKey: randomUUID(), ...over }));
const row = async (id: string) => (await admin.query('SELECT * FROM outbox_events WHERE id=$1', [id])).rows[0];
const runner = (w = 'w1') => new JobRunner({ queue: queue(), appPool: app, workerId: w, concurrency: 8 });

beforeAll(async () => {
  app = createPool(process.env.TEST_APP_URL!, 5);
  system = createPool(process.env.TEST_SYSTEM_URL!, 5);
  admin = createPool(process.env.TEST_ADMIN_URL!, 2);
  userId = (await app.query(`SELECT app.upsert_user_from_identity($1,'jobs@example.test','jobs',true) AS id`, [`jobs-${randomUUID()}`])).rows[0].id;
  tenantId = (await system.query(`SELECT app.provision_tenant($1,'Jobs','Jobs',$2) AS id`, [`jobs-${randomUUID().slice(0, 8)}`, userId])).rows[0].id;
  otherTenant = (await system.query(`SELECT app.provision_tenant($1,'Other','Other',$2) AS id`, [`other-${randomUUID().slice(0, 8)}`, userId])).rows[0].id;
});
afterAll(async () => { await Promise.all([app.end(), system.end(), admin.end()]); });

describe('producer', () => {
  it('is idempotent per tenant+key', async () => {
    const key = randomUUID();
    const a = await enqueue('x.y', { idempotencyKey: key });
    const b = await enqueue('x.y', { idempotencyKey: key });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    const c = await enqueue('x.y', { idempotencyKey: key }, otherTenant); // same key, other tenant => separate job
    expect(c.created).toBe(true);
  });
  it('rolls back with the business transaction (no job without the change)', async () => {
    const key = randomUUID();
    await expect(withContext(app, { tenantId, userId }, async (c) => {
      await producer.enqueue(c, { tenantId, type: 'x.y', aggregateType: 't', aggregateId: randomUUID(), idempotencyKey: key });
      throw new Error('business rule failed');
    })).rejects.toThrow('business rule failed');
    expect((await admin.query('SELECT 1 FROM outbox_events WHERE idempotency_key=$1', [key])).rowCount).toBe(0);
  });
  it('cannot enqueue for another tenant (RLS WITH CHECK)', async () => {
    await expect(withContext(app, { tenantId, userId }, (c) =>
      producer.enqueue(c, { tenantId: otherTenant, type: 'x', aggregateType: 't', aggregateId: randomUUID(), idempotencyKey: randomUUID() }))).rejects.toMatchObject({ code: '42501' });
  });
  it('delayed jobs are not claimed early', async () => {
    await admin.query('DELETE FROM outbox_events');
    await enqueue('later', { availableAt: new Date(Date.now() + 3_600_000) });
    expect(await queue().claim(10, 'w')).toHaveLength(0);
  });
});

describe('runner', () => {
  it('runs a handler inside the job tenant’s RLS scope and completes the job', async () => {
    await admin.query('DELETE FROM outbox_events');
    const seen: Array<{ visibleTenants: number; job: Job }> = [];
    const r = runner().register('probe', async (job, ctx) => {
      const visible = await ctx.tx(async (c) => (await c.query('SELECT count(*)::int n FROM tenants WHERE id = app.current_tenant_id()')).rows[0].n);
      seen.push({ visibleTenants: visible, job });
    });
    const { id } = await enqueue('probe', { payload: { a: 1 }, correlationId: 'req-1' });
    expect(await r.runOnce()).toBe(1);
    expect(seen[0]!.job).toMatchObject({ tenantId, type: 'probe', payload: { a: 1 }, correlationId: 'req-1', attempts: 1 });
    expect(seen[0]!.visibleTenants).toBe(1);
    expect((await row(id)).processed_at).not.toBeNull();
    expect(await r.runOnce()).toBe(0); // nothing is processed twice
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    await admin.query('DELETE FROM outbox_events');
    let calls = 0;
    const r = runner().register('flaky', async () => { calls += 1; if (calls < 2) throw new Error('network blip'); });
    const { id } = await enqueue('flaky');
    await r.runOnce();
    const afterFail = await row(id);
    expect(afterFail.processed_at).toBeNull();
    expect(afterFail.last_error_code).toBe('handler_error');
    expect(new Date(afterFail.available_at).getTime()).toBeGreaterThan(Date.now());
    expect(await r.runOnce()).toBe(0); // backoff: not yet available
    await admin.query('UPDATE outbox_events SET available_at = now() WHERE id=$1', [id]);
    await r.runOnce();
    expect((await row(id)).processed_at).not.toBeNull();
    expect(calls).toBe(2);
  });

  it('dead-letters after max attempts', async () => {
    await admin.query('DELETE FROM outbox_events');
    const r = runner().register('doomed', async () => { throw new Error('always'); });
    const { id } = await enqueue('doomed', { maxAttempts: 2 });
    await r.runOnce();
    await admin.query('UPDATE outbox_events SET available_at = now() WHERE id=$1', [id]);
    await r.runOnce();
    const final = await row(id);
    expect(final.dead_lettered_at).not.toBeNull();
    expect(final.attempts).toBe(2);
  });

  it('dead-letters immediately on PermanentJobError and on unknown job types', async () => {
    await admin.query('DELETE FROM outbox_events');
    const r = runner().register('bad-payload', async () => { throw new PermanentJobError('invalid_payload', 'missing employeeId'); });
    const a = await enqueue('bad-payload');
    const b = await enqueue('nobody-handles-this');
    await r.runOnce();
    expect((await row(a.id)).dead_lettered_at).not.toBeNull();
    expect((await row(a.id)).last_error_code).toBe('invalid_payload');
    expect((await row(b.id)).last_error_code).toBe('no_handler');
    expect((await row(b.id)).dead_lettered_at).not.toBeNull();
  });

  it('two workers never process the same job', async () => {
    await admin.query('DELETE FROM outbox_events');
    const handled: string[] = [];
    const mk = (w: string) => runner(w).register('count', async (job) => { handled.push(job.id); await new Promise((r) => setTimeout(r, 5)); });
    for (let i = 0; i < 40; i++) await enqueue('count');
    const [a, b] = [mk('wa'), mk('wb')];
    await Promise.all([a.runOnce(), b.runOnce(), a.runOnce(), b.runOnce(), a.runOnce(), b.runOnce()]);
    expect(handled.length).toBe(40);
    expect(new Set(handled).size).toBe(40);
  });

  it('a crashed worker’s lease expires and another worker picks the job up', async () => {
    await admin.query('DELETE FROM outbox_events');
    const { id } = await enqueue('orphan');
    await queue().claim(1, 'crashed-worker', 300);
    expect(await queue().claim(1, 'w2')).toHaveLength(0); // still leased
    await admin.query(`UPDATE outbox_events SET claim_expires_at = now() - interval '1 second' WHERE id=$1`, [id]);
    const again = await queue().claim(1, 'w2');
    expect(again.map((j) => j.id)).toEqual([id]);
    expect(again[0]!.attempts).toBe(2);
  });

  it('start/stop loop drains work and shuts down gracefully', async () => {
    await admin.query('DELETE FROM outbox_events');
    let done = 0;
    const r = new JobRunner({ queue: queue(), appPool: app, workerId: 'loop', pollIntervalMs: 20 })
      .register('tick', async () => { await new Promise((x) => setTimeout(x, 30)); done += 1; });
    for (let i = 0; i < 5; i++) await enqueue('tick');
    r.start();
    await new Promise((x) => setTimeout(x, 400));
    await r.stop();
    expect(done).toBe(5);
    expect((await admin.query('SELECT count(*)::int n FROM outbox_events WHERE processed_at IS NULL')).rows[0].n).toBe(0);
  });
});
