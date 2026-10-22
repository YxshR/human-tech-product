import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobRunner, PostgresJobQueue } from '@humantech/jobs';
import { LocalFileStorage } from '@humantech/storage';
import { World, createWorld } from '../../api/test/fixtures';
import { FinalRun, seedFinalizedRun } from '../../api/test/payroll-fixture';
import { MemoryMailer } from '../src/mailer';
import { registerHandlers } from '../src/registry';
import { scheduleDailyJobs } from '../src/scheduler';

let w: World; let fx: FinalRun; let mailer: MemoryMailer; let runner: JobRunner; let storage: LocalFileStorage;
const logs: string[] = [];
/** Runs queued work until the queue is empty (retries are pushed into the future, so this always ends). */
const drain = async () => { let n = 0; for (let i = 0; i < 10; i++) { const k = await runner.runOnce(); if (!k) break; n += k; } return n; };
const outbox = async (type: string) => (await w.admin.query(`SELECT * FROM outbox_events WHERE tenant_id=$1 AND event_type=$2 ORDER BY created_at`, [fx.tenant.id, type])).rows;
const call = async (m: 'get' | 'post', sub: string, path: string, body?: object, mfa = true) => w.h.http()[m](path).set(await w.as(sub, fx.tenant, { mfa })).send(body);

beforeAll(async () => {
  w = await createWorld();
  fx = await seedFinalizedRun(w, 'wk');
  mailer = new MemoryMailer();
  storage = new LocalFileStorage(process.env.TEST_STORAGE_DIR ?? '/tmp/humantech-test-files');
  runner = registerHandlers(new JobRunner({ queue: new PostgresJobQueue(w.system), appPool: w.app, workerId: 'test-worker', concurrency: 4, logger: (m) => logs.push(m) }),
    { mailer, storage, webBaseUrl: 'https://app.example.test/' });
});
afterAll(() => w.close());

describe('payroll.finalized -> payslip PDFs', () => {
  it('payslips are pending (no file yet) until the worker has run', async () => {
    const mine = (await call('get', fx.subs.e1, '/me/payslips')).body.data;
    expect(mine).toHaveLength(1); expect(mine[0].status).toBe('pending');
    const early = await call('get', fx.subs.e1, `/me/payslips/${mine[0].id}/download-link`);
    expect(early.status).toBe(409);
  });
  it('renders, stores and announces every payslip; re-running is harmless', async () => {
    await drain();
    const job = (await outbox('payroll.finalized'))[0];
    expect(job.processed_at).not.toBeNull(); expect(job.dead_lettered_at).toBeNull();
    const slips = (await w.admin.query(`SELECT s.status, s.file_id, f.purpose, f.content_type, f.status AS fstatus, f.size_bytes::int AS size FROM payslips s LEFT JOIN stored_files f ON f.id=s.file_id WHERE s.tenant_id=$1`, [fx.tenant.id])).rows;
    expect(slips).toHaveLength(2);
    for (const s of slips) expect(s).toMatchObject({ status: 'ready', purpose: 'payslip', content_type: 'application/pdf', fstatus: 'clean' });
    const notes = (await w.admin.query(`SELECT recipient_user_id, title FROM notifications WHERE tenant_id=$1 AND event_key='payslip.ready' ORDER BY title`, [fx.tenant.id])).rows;
    expect(notes.map((n) => n.recipient_user_id).sort()).toEqual([w.users[fx.subs.e1], w.users[fx.subs.e2]].sort());
    expect(notes[0].title).toBe('Your September 2026 payslip is ready');
    // a duplicate delivery of the same job must not create new files or notifications
    await w.admin.query(`UPDATE outbox_events SET processed_at=NULL, claimed_by=NULL, claim_expires_at=NULL, attempts=0 WHERE id=$1`, [job.id]);
    await drain();
    expect((await w.admin.query(`SELECT count(*)::int n FROM stored_files WHERE tenant_id=$1 AND purpose='payslip'`, [fx.tenant.id])).rows[0].n).toBe(2);
    expect((await w.admin.query(`SELECT count(*)::int n FROM notifications WHERE tenant_id=$1 AND event_key='payslip.ready'`, [fx.tenant.id])).rows[0].n).toBe(2);
  });
  it('an employee downloads their own payslip through a signed link, and nobody else can', async () => {
    const mine = (await call('get', fx.subs.e1, '/me/payslips')).body.data[0];
    expect(mine.status).toBe('ready');
    const link = (await call('get', fx.subs.e1, `/me/payslips/${mine.id}/download-link`)).body.data;
    const dl = await w.h.http().get(link.url).set(await w.as(fx.subs.e1, fx.tenant)).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(dl.status).toBe(200); expect(dl.headers['content-type']).toBe('application/pdf');
    expect((dl.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(String(dl.headers['content-disposition'])).toContain('payslip-2026-09-');
    // colleague: neither the link nor a replayed link works
    expect((await call('get', fx.subs.e2, `/me/payslips/${mine.id}/download-link`)).status).toBe(404);
    expect((await w.h.http().get(link.url).set(await w.as(fx.subs.e2, fx.tenant))).status).toBe(404);
    // finance and the approver hold payslip.read_any
    expect((await call('get', fx.subs.fin, `/payroll/payslips/${mine.id}/download-link`)).status).toBe(200);
    expect((await call('get', fx.subs.appr, `/payroll/payslips/${mine.id}/download-link`)).status).toBe(200);   // the approver role may read payslips too
    const events = (await w.admin.query(`SELECT action FROM file_access_events WHERE tenant_id=$1 AND file_id=(SELECT file_id FROM payslips WHERE id=$2) ORDER BY created_at`, [fx.tenant.id, mine.id])).rows.map((r) => r.action);
    expect(events).toEqual(['download_url_issued', 'download', 'download_url_issued', 'download_url_issued']);
  });
});

describe('invitation.email', () => {
  const invite = async (email: string) => { const r = await call('post', 'wk-root', '/access/invitations', { email, roleKeys: ['employee'], branchScope: 'all' }); if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return r.body.data; };

  it('sends the mail with a one-time link, then erases the token from the stored job', async () => {
    const inv = await invite('new.joiner@example.test');
    expect((await outbox('invitation.email')).find((o) => o.aggregate_id === inv.id).payload.token).toBe(inv.acceptToken);   // present while queued
    await drain();
    expect(mailer.sent).toHaveLength(1);
    const m = mailer.sent[0]!;
    expect(m.to).toBe('new.joiner@example.test'); expect(m.subject).toMatch(/^Join .* on humanTech$/);
    expect(m.text).toContain(`https://app.example.test/accept-invite?token=${encodeURIComponent(inv.acceptToken)}`); expect(m.html).toContain('accept-invite?token=');
    const row = (await outbox('invitation.email')).find((o) => o.aggregate_id === inv.id);
    expect(row.processed_at).not.toBeNull(); expect(row.payload).not.toHaveProperty('token'); expect(row.payload.email).toBe('new.joiner@example.test');
    const d = (await w.admin.query(`SELECT status, attempts, provider_message_id FROM notification_deliveries WHERE tenant_id=$1 AND idempotency_key=$2`, [fx.tenant.id, `invitation:${inv.id}`])).rows[0];
    expect(d).toMatchObject({ status: 'sent', attempts: 1, provider_message_id: 'mem-1' });
  });
  it('retries after a transient mail failure and keeps the token until it is sent', async () => {
    const before = mailer.sent.length;
    const inv = await invite('flaky@example.test');
    mailer.failNext = 1;
    await drain();
    expect(mailer.sent).toHaveLength(before);
    let row = (await outbox('invitation.email')).find((o) => o.aggregate_id === inv.id);
    expect(row.processed_at).toBeNull(); expect(row.attempts).toBe(1); expect(row.last_error_code).toBe('handler_error'); expect(row.payload.token).toBe(inv.acceptToken);
    await w.admin.query(`UPDATE outbox_events SET available_at=now() WHERE id=$1`, [row.id]);
    await drain();
    expect(mailer.sent).toHaveLength(before + 1);
    row = (await outbox('invitation.email')).find((o) => o.aggregate_id === inv.id);
    expect(row.processed_at).not.toBeNull(); expect(row.payload).not.toHaveProperty('token');
  });
  it('does not mail a revoked invitation, and still scrubs the secret', async () => {
    const before = mailer.sent.length;
    const inv = await invite('revoked@example.test');
    expect((await call('post', 'wk-root-boot', `/access/invitations/${inv.id}/revoke`)).status).toBe(204);
    await drain();
    expect(mailer.sent).toHaveLength(before);
    const row = (await outbox('invitation.email')).find((o) => o.aggregate_id === inv.id);
    expect(row.processed_at).not.toBeNull(); expect(row.payload).not.toHaveProperty('token');
    expect((await w.admin.query(`SELECT status FROM notification_deliveries WHERE idempotency_key=$1`, [`invitation:${inv.id}`])).rows[0].status).toBe('suppressed');
  });
  it('a re-delivered job whose mail already left does not send twice', async () => {
    const before = mailer.sent.length;
    const inv = await invite('twice@example.test');
    await drain();
    expect(mailer.sent).toHaveLength(before + 1);
    const row = (await outbox('invitation.email')).find((o) => o.aggregate_id === inv.id);
    await w.admin.query(`UPDATE outbox_events SET processed_at=NULL, claimed_by=NULL, claim_expires_at=NULL WHERE id=$1`, [row.id]);
    await drain();
    expect(mailer.sent).toHaveLength(before + 1);
  });
});

describe('scheduler & leave jobs', () => {
  it('enqueues one accrual job per active tenant per local day, no matter how often it runs', async () => {
    const a = await scheduleDailyJobs(w.system); const b = await scheduleDailyJobs(w.system);
    expect(a.accrual).toBeGreaterThan(0); expect(b).toEqual({ accrual: 0, expiry: 0 });
    const jobs = await outbox('leave.accrue');
    expect(jobs).toHaveLength(1); expect(jobs[0].payload.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await drain();
    expect((await outbox('leave.accrue'))[0].processed_at).not.toBeNull();
  });
  it('handlers reject malformed payloads permanently (dead-letter, no endless retry)', async () => {
    await w.app.query('SELECT 1');
    await w.admin.query(`INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key) VALUES ($1,'tenants',$1,'leave.accrue','{"asOf":"yesterday"}','bad-1'), ($1,'tenants',$1,'unknown.type','{}','bad-2')`, [fx.tenant.id]);
    await drain();
    const bad = (await w.admin.query(`SELECT event_type, dead_lettered_at, last_error_code FROM outbox_events WHERE idempotency_key IN ('bad-1','bad-2') ORDER BY idempotency_key`)).rows;
    expect(bad.map((r) => [r.event_type, r.last_error_code])).toEqual([['leave.accrue', 'invalid_payload'], ['unknown.type', 'no_handler']]);
    for (const r of bad) expect(r.dead_lettered_at).not.toBeNull();
  });
});
