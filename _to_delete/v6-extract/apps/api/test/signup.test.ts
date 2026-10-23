import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveSignup, listSignupRequests } from '@humantech/database';
import { World, createWorld } from './fixtures';

let w: World;
beforeAll(async () => { w = await createWorld(); });
afterAll(() => w.close());
const post = (body: object) => w.h.http().post('/public/signup-requests').send(body);
const good = { planCode: 'pro', companyName: 'Sunrise Traders Pvt Ltd', contactName: 'Anil Rao', email: ' Anil@Sunrise.TEST ', phone: '+91 98765 43210', employeeCount: 40 };

describe('public sign-up requests', () => {
  it('needs no login, normalises the e-mail and stores the request', async () => {
    const r = await post(good);
    expect(r.status).toBe(202);
    expect(r.body.data).toEqual({ received: true });
    const rows = await listSignupRequests(w.system);
    expect(rows.find((x) => x.email === 'anil@sunrise.test')).toMatchObject({ planCode: 'pro', companyName: 'Sunrise Traders Pvt Ltd', status: 'awaiting_payment', employeeCount: 40 });
  });
  it('a repeated open request is accepted but not duplicated', async () => {
    expect((await post(good)).status).toBe(202);
    expect((await listSignupRequests(w.system)).filter((x) => x.email === 'anil@sunrise.test')).toHaveLength(1);
  });
  it('rejects bad plans, bad e-mails and unknown fields', async () => {
    expect((await post({ ...good, planCode: 'free' })).status).toBe(422);
    expect((await post({ ...good, email: 'nope' })).status).toBe(422);
    expect((await post({ ...good, tenantId: 'x' })).status).toBe(422);
  });
  it('the bot trap field is answered like a real request but stores nothing', async () => {
    expect((await post({ ...good, email: 'bot@spam.test', website: 'http://spam' })).status).toBe(202);
    expect((await listSignupRequests(w.system)).some((x) => x.email === 'bot@spam.test')).toBe(false);
  });
  it('the runtime role cannot read requests back', async () => {
    await expect(w.app.query('SELECT * FROM signup_requests')).rejects.toThrow(/permission denied/);
  });
  it('approving creates the company, an active subscription and an invitation, once', async () => {
    const id = (await listSignupRequests(w.system)).find((x) => x.email === 'anil@sunrise.test')!.id;
    const c = await approveSignup(w.owner, w.system, id, 'sunrise-traders', 'ops@humantech.test');
    expect(c.inviteToken).toHaveLength(43);
    const sub = (await w.admin.query(`SELECT s.status, p.code FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.tenant_id=$1`, [c.tenantId])).rows[0];
    expect(sub).toEqual({ status: 'active', code: 'pro' });
    await expect(approveSignup(w.owner, w.system, id, 'sunrise-2', 'ops@humantech.test')).rejects.toThrow('already approved');
  });
  it('is rate limited per address', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post({ ...good, email: `r${i}@rate.test` })).status);
    expect(codes).toContain(429);
  });
});
