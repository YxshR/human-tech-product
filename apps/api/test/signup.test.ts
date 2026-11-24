import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, createWorld } from './fixtures';

let w: World;
beforeAll(async () => { w = await createWorld(); });
afterAll(() => w.close());

/** A signed-in person with no company yet (no X-Tenant-Id header). */
const asNewcomer = async (sub: string) => {
  const t = await w.tenant(`su-${sub}`, `${sub}-root`);   // any tenant just to mint a token for `sub`
  const h = { ...(await w.as(sub, t)) }; delete h['X-Tenant-Id'];
  return h;
};
const create = (h: Record<string, string>, body: object) => w.h.http().post('/me/company').set(h).send(body);

describe('self-service sign-up', () => {
  it('needs a login', async () => {
    expect((await w.h.http().post('/me/company').send({ planCode: 'free', companyName: 'Nope Ltd' })).status).toBe(401);
  });

  it('creates the company, makes the person its administrator and starts a free subscription', async () => {
    const h = await asNewcomer('ss-free');
    const r = await create(h, { planCode: 'free', companyName: 'Sunrise Traders Pvt Ltd' });
    expect(r.status).toBe(201);
    const tenantId = r.body.data.tenantId as string;

    const me = await w.h.http().get('/me').set(h);
    expect(me.body.data.companies).toEqual([{ id: tenantId, name: 'Sunrise Traders Pvt Ltd' }]);

    const perms = await w.h.http().get('/me/permissions').set({ ...h, 'X-Tenant-Id': tenantId });
    expect(perms.status).toBe(200);
    expect(perms.body.data.permissions).toContain('role.manage');
    expect(perms.body.data.branchScope).toBe('all');

    const sub = (await w.admin.query(`SELECT s.status, p.code, s.trial_ends_at FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.tenant_id=$1`, [tenantId])).rows[0];
    expect(sub).toEqual({ status: 'active', code: 'free', trial_ends_at: null });
    const roles = (await w.admin.query(`SELECT count(*)::int n FROM roles WHERE tenant_id=$1 AND is_system_role`, [tenantId])).rows[0].n;
    expect(roles).toBeGreaterThanOrEqual(9);
    const audit = (await w.admin.query(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='company.self_signup'`, [tenantId])).rowCount;
    expect(audit).toBe(1);
  });

  it('Pro and Customize start as a 14-day trial', async () => {
    for (const planCode of ['pro', 'customize'] as const) {
      const h = await asNewcomer(`ss-${planCode}`);
      const r = await create(h, { planCode, companyName: `${planCode} company` });
      expect(r.status).toBe(201);
      const sub = (await w.admin.query(`SELECT s.status, p.code, (s.trial_ends_at > now() + interval '13 days') AS long_trial FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.tenant_id=$1`, [r.body.data.tenantId])).rows[0];
      expect(sub).toEqual({ status: 'trialing', code: planCode, long_trial: true });
    }
  });

  it('two companies may share a name', async () => {
    const a = await create(await asNewcomer('ss-dup-a'), { planCode: 'free', companyName: 'Same Name' });
    const b = await create(await asNewcomer('ss-dup-b'), { planCode: 'free', companyName: 'Same Name' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.tenantId).not.toBe(b.body.data.tenantId);
  });

  it('a person who already belongs to a company cannot create another', async () => {
    const h = await asNewcomer('ss-twice');
    expect((await create(h, { planCode: 'free', companyName: 'First Ltd' })).status).toBe(201);
    expect((await create(h, { planCode: 'free', companyName: 'Second Ltd' })).status).toBe(409);
  });

  it('rejects unknown or retired plans, short names and extra fields', async () => {
    const h = await asNewcomer('ss-bad');
    expect((await create(h, { planCode: 'plus', companyName: 'Old Plan Ltd' })).status).toBe(422);
    expect((await create(h, { planCode: 'gold', companyName: 'Gold Ltd' })).status).toBe(422);
    expect((await create(h, { planCode: 'free', companyName: 'x' })).status).toBe(422);
    expect((await create(h, { planCode: 'free', companyName: 'Fine Ltd', tenantId: 'x' })).status).toBe(422);
    expect((await w.h.http().get('/me').set(h)).body.data.companies).toEqual([]);
  });

  it('is rate limited per person', async () => {
    const h = await asNewcomer('ss-rate');
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await create(h, { planCode: 'free', companyName: 'x' })).status);
    expect(codes).toContain(429);
  });

  it('the function cannot be used to touch an existing company', async () => {
    // It only ever inserts a brand-new tenant; there is no tenant argument at all.
    const before = (await w.admin.query('SELECT count(*)::int n FROM tenants')).rows[0].n;
    const h = await asNewcomer('ss-count');
    await create(h, { planCode: 'free', companyName: 'Counted Ltd' });
    const after = (await w.admin.query('SELECT count(*)::int n FROM tenants')).rows[0].n;
    expect(after - before).toBe(2);   // the helper tenant used to mint the token + the new company
  });
});
