import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let A: Tenant; let B: Tenant;
let empId: string; let mgrEmpId: string; let otherBranchEmp: string; let dualEmp: string;
const call = async (m: 'get' | 'post' | 'patch', sub: string, t: Tenant, path: string, body?: object, o?: { mfa?: boolean }) =>
  w.h.http()[m](path).set(await w.as(sub, t, o)).send(body);
const ids: Record<string, string> = {};

// Far-future dates so "start in the past" rules never interfere. 2031-03-03 is a Monday.
const MON = '2031-03-03'; const TUE = '2031-03-04'; const WED = '2031-03-05'; const THU = '2031-03-06'; const FRI = '2031-03-07';

beforeAll(async () => {
  w = await createWorld();
  A = await w.tenant('lv-a', 'lva-root');
  B = await w.tenant('lv-b', 'lvb-root');
  await w.member(A, 'lva-root-boot', 'lva-hr', ['hr_admin']);
  await w.member(A, 'lva-root-boot', 'lva-mgr', ['store_manager'], [A.branch]);
  await w.member(A, 'lva-root-boot', 'lva-emp', ['employee'], [A.branch]);
  await w.member(A, 'lva-root-boot', 'lva-emp2', ['employee'], [A.branch2]);
  await w.member(A, 'lva-root-boot', 'lva-dual', ['hr_admin'], [A.branch]);
  mgrEmpId = await w.employee(A, 'lva-root-boot', 'lva-mgr');
  empId = await w.employee(A, 'lva-root-boot', 'lva-emp', { manager: mgrEmpId });
  otherBranchEmp = await w.employee(A, 'lva-root-boot', 'lva-emp2', { branch: A.branch2 });
  dualEmp = await w.employee(A, 'lva-root-boot', 'lva-dual');

  const hr = (p: string, b: object) => call('post', 'lva-hr', A, p, b);
  ids.cl = (await hr('/leave/types', { code: 'cl', name: 'Casual Leave', maxNegativeDays: '0' })).body.data.id;
  ids.lop = (await hr('/leave/types', { code: 'LOP', name: 'Loss of Pay', isPaid: false })).body.data.id;
  ids.auto = (await hr('/leave/types', { code: 'COMP', name: 'Comp-off', requiresApproval: false })).body.data.id;
  const pol = await hr('/leave/policies', { leaveTypeId: ids.cl, effectiveFrom: '2030-01-01', accrualFrequency: 'monthly', accrualDays: '1.5', carryForwardMaxDays: '2' });
  await hr(`/leave/policies/${pol.body.data.id}/activate`, {});
  for (const e of [empId, dualEmp, otherBranchEmp]) {
    await hr('/leave/balances/adjust', { employeeId: e, leaveTypeId: ids.cl, days: '5', effectiveDate: '2030-01-01', reason: 'opening', kind: 'opening_grant' });
  }
  await hr('/leave/balances/adjust', { employeeId: empId, leaveTypeId: ids.auto, days: '1', effectiveDate: '2030-01-01', reason: 'opening', kind: 'opening_grant' });
});
afterAll(() => w.close());

const balance = async (sub: string, type = 'CL') =>
  (await call('get', sub, A, '/leave/balances')).body.data.find((b: { leaveTypeCode: string }) => b.leaveTypeCode === type);
const attendanceDates = async (emp: string) =>
  (await w.admin.query(`SELECT to_char(work_date,'YYYY-MM-DD') d FROM attendance_days WHERE employee_id=$1 AND attendance_status='leave' ORDER BY 1`, [emp])).rows.map((r) => r.d);

describe('types & policies', () => {
  it('only policy managers write; codes normalise; duplicates 409', async () => {
    expect((await call('post', 'lva-emp', A, '/leave/types', { code: 'X', name: 'Xx' })).status).toBe(403);
    expect((await call('post', 'lva-hr', A, '/leave/types', { code: 'cl', name: 'dup' })).status).toBe(409);
    const t = (await call('get', 'lva-emp', A, '/leave/types')).body.data;
    expect(t.map((x: { code: string }) => x.code)).toEqual(['CL', 'COMP', 'LOP']);
  });
  it('overlapping active policies for one type are rejected; lifecycle is enforced', async () => {
    const p2 = await call('post', 'lva-hr', A, '/leave/policies', { leaveTypeId: ids.cl, effectiveFrom: '2030-06-01', accrualFrequency: 'yearly', accrualDays: '12' });
    expect(p2.body.data).toMatchObject({ version: 2, status: 'draft' });
    expect((await call('post', 'lva-hr', A, `/leave/policies/${p2.body.data.id}/activate`)).status).toBe(409);
    expect((await call('post', 'lva-hr', A, `/leave/policies/${p2.body.data.id}/retire`)).status).toBe(409);
  });
  it('validates policy input', async () => {
    expect((await call('post', 'lva-hr', A, '/leave/policies', { leaveTypeId: ids.cl, effectiveFrom: '2030-06-01', effectiveTo: '2030-01-01', accrualFrequency: 'yearly', accrualDays: '1' })).status).toBe(422);
    expect((await call('post', 'lva-hr', A, '/leave/policies', { leaveTypeId: ids.cl, effectiveFrom: '2030-06-01', accrualFrequency: 'weekly', accrualDays: '1' })).status).toBe(422);
  });
});

describe('request lifecycle', () => {
  let reqId: string;
  it('employee applies for Mon-Wed: 3 days, pending, counted against availability', async () => {
    const r = await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: MON, endDate: WED, reason: 'family' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'pending', requestedDays: '3.00', leaveTypeCode: 'CL', employeeId: empId });
    reqId = r.body.data.id;
    expect(await balance('lva-emp')).toMatchObject({ balanceDays: '5.00', pendingDays: '3.00', availableDays: '2.00' });
  });
  it('overlap and over-balance are rejected', async () => {
    expect((await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: TUE, endDate: TUE })).status).toBe(409);
    const r = await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: '2031-04-01', endDate: '2031-04-08' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('insufficient_balance');
  });
  it('employee cannot approve; version conflict; reject needs a reason', async () => {
    expect((await call('post', 'lva-emp', A, `/leave/requests/${reqId}/approve`, { version: 1 })).status).toBe(403);
    expect((await call('post', 'lva-mgr', A, `/leave/requests/${reqId}/approve`, { version: 9 })).body.error.code).toBe('version_conflict');
    expect((await call('post', 'lva-mgr', A, `/leave/requests/${reqId}/reject`, { version: 1 })).status).toBe(422);
  });
  it('other-branch manager cannot even see it; employee in other branch cannot see it', async () => {
    expect((await call('get', 'lva-emp2', A, `/leave/requests/${reqId}`)).status).toBe(404);
    expect((await call('get', 'lvb-root', B, `/leave/requests/${reqId}`)).status).toBe(404);
  });
  it('manager approves: ledger usage, balance drops, attendance projected', async () => {
    const r = await call('post', 'lva-mgr', A, `/leave/requests/${reqId}/approve`, { version: 1, comment: 'ok' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'approved', decisionComment: 'ok' });
    expect(await balance('lva-emp')).toMatchObject({ balanceDays: '2.00', pendingDays: '0.00' });
    expect(await attendanceDates(empId)).toEqual([MON, TUE, WED]);
    const led = (await call('get', 'lva-emp', A, `/leave/balances/ledger?leaveTypeId=${ids.cl}`)).body.data;
    expect(led.find((l: { transactionType: string }) => l.transactionType === 'usage')).toMatchObject({ daysDelta: '-3.000', sourceRequestId: reqId });
  });
  it('a decided request cannot be decided again', async () => {
    expect((await call('post', 'lva-mgr', A, `/leave/requests/${reqId}/approve`, { version: 2 })).status).toBe(409);
  });
  it('employee cancels future approved leave: balance restored, attendance removed', async () => {
    const cur = (await call('get', 'lva-emp', A, `/leave/requests/${reqId}`)).body.data;
    const r = await call('post', 'lva-emp', A, `/leave/requests/${reqId}/cancel`, { version: cur.version });
    expect(r.body.data.status).toBe('cancelled');
    expect(await balance('lva-emp')).toMatchObject({ balanceDays: '5.00' });
    expect(await attendanceDates(empId)).toEqual([]);
    expect((await call('post', 'lva-emp', A, `/leave/requests/${reqId}/cancel`, { version: r.body.data.version })).status).toBe(409);
  });
  it('rejection leaves balance untouched', async () => {
    const r = await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: THU, endDate: THU });
    const rej = await call('post', 'lva-mgr', A, `/leave/requests/${r.body.data.id}/reject`, { version: 1, comment: 'busy' });
    expect(rej.body.data).toMatchObject({ status: 'rejected', decisionComment: 'busy' });
    expect(await balance('lva-emp')).toMatchObject({ balanceDays: '5.00', pendingDays: '0.00' });
  });
  it('segregation of duties: nobody approves their own leave', async () => {
    const r = await call('post', 'lva-dual', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: FRI, endDate: FRI });
    expect(r.status).toBe(201);
    const d = await call('post', 'lva-dual', A, `/leave/requests/${r.body.data.id}/approve`, { version: 1 });
    expect(d.status).toBe(403);
    expect(d.body.error.code).toBe('maker_checker_violation');
    expect((await call('post', 'lva-hr', A, `/leave/requests/${r.body.data.id}/approve`, { version: 1 })).status).toBe(200);
  });
});

describe('day counting inside the API', () => {
  it('skips Sunday and a branch/tenant holiday', async () => {
    await call('post', 'lva-hr', A, '/holidays', { holidayDate: '2031-05-12', name: 'Test Holiday' });
    // Fri 9, Sat 10, Sun 11, Mon 12 (holiday), Tue 13 -> Fri, Sat, Tue = 3
    const r = await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: '2031-05-09', endDate: '2031-05-13' });
    expect(r.body.data.requestedDays).toBe('3.00');
  });
  it('half day = 0.5 and cannot span dates; range with no working days is 422', async () => {
    const h = await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: '2031-06-02', endDate: '2031-06-02', partialDay: 'first_half' });
    expect(h.body.data.requestedDays).toBe('0.50');
    expect((await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: '2031-06-03', endDate: '2031-06-04', partialDay: 'first_half' })).status).toBe(422);
    expect((await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: '2031-06-08', endDate: '2031-06-08' })).status).toBe(422); // Sunday
  });
  it('opposite half days on one date may coexist', async () => {
    const h = await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: '2031-06-02', endDate: '2031-06-02', partialDay: 'second_half' });
    expect(h.status).toBe(201);
  });
});

describe('type variants', () => {
  it('unpaid (LOP) needs no balance and writes no ledger row', async () => {
    const r = await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.lop, startDate: '2031-07-07', endDate: '2031-07-09' });
    expect(r.status).toBe(201);
    await call('post', 'lva-mgr', A, `/leave/requests/${r.body.data.id}/approve`, { version: 1 });
    const n = (await w.admin.query(`SELECT count(*)::int n FROM leave_balance_transactions WHERE source_request_id=$1`, [r.body.data.id])).rows[0].n;
    expect(n).toBe(0);
    const fr = (await w.admin.query(`SELECT paid_day_fraction::text f FROM attendance_days WHERE employee_id=$1 AND work_date='2031-07-07'`, [empId])).rows[0].f;
    expect(fr).toBe('0.000');
  });
  it('no-approval types are auto-approved and consume balance immediately', async () => {
    const r = await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.auto, startDate: '2031-08-04', endDate: '2031-08-04' });
    expect(r.body.data).toMatchObject({ status: 'approved', autoApproved: true });
    expect(await balance('lva-emp', 'COMP')).toMatchObject({ balanceDays: '0.00' });
    // balance exhausted -> next one is refused
    expect((await call('post', 'lva-emp', A, '/leave/requests', { leaveTypeId: ids.auto, startDate: '2031-08-05', endDate: '2031-08-05' })).status).toBe(409);
  });
  it('HR can apply on behalf of an employee in scope; scoped HR cannot for another branch', async () => {
    const ok = await call('post', 'lva-hr', A, '/leave/requests', { employeeId: otherBranchEmp, leaveTypeId: ids.cl, startDate: '2031-09-01', endDate: '2031-09-01' });
    expect(ok.status).toBe(201);
    await w.member(A, 'lva-root-boot', 'lva-hr1', ['hr_admin'], [A.branch]);
    expect((await call('post', 'lva-hr1', A, '/leave/requests', { employeeId: otherBranchEmp, leaveTypeId: ids.cl, startDate: '2031-09-02', endDate: '2031-09-02' })).status).toBe(404);
  });
  it('a user without an employee profile must name one', async () => {
    const r = await call('post', 'lva-root', A, '/leave/requests', { leaveTypeId: ids.cl, startDate: MON, endDate: MON });
    expect(r.status).toBe(422);
  });
});

describe('listing & scope', () => {
  it('employee sees only own; manager sees team + branch; HR sees all; cursor pages', async () => {
    const mine = (await call('get', 'lva-emp', A, '/leave/requests?limit=100')).body.data;
    expect(mine.every((x: { employeeId: string }) => x.employeeId === empId)).toBe(true);
    const mgr = (await call('get', 'lva-mgr', A, '/leave/requests?limit=100')).body.data;
    expect(mgr.some((x: { employeeId: string }) => x.employeeId === otherBranchEmp)).toBe(false);
    expect(mgr.some((x: { employeeId: string }) => x.employeeId === empId)).toBe(true);
    const all = (await call('get', 'lva-hr', A, '/leave/requests?limit=100')).body.data;
    expect(all.some((x: { employeeId: string }) => x.employeeId === otherBranchEmp)).toBe(true);
    const p1 = await call('get', 'lva-hr', A, '/leave/requests?limit=2');
    expect(p1.body.data).toHaveLength(2);
    const p2 = await call('get', 'lva-hr', A, `/leave/requests?limit=2&cursor=${p1.body.page.nextCursor}`);
    expect(p2.body.data.map((x: { id: string }) => x.id)).not.toContain(p1.body.data[0].id);
    expect((await call('get', 'lva-hr', A, '/leave/requests?cursor=garbage')).status).toBe(422);
    expect((await call('get', 'lva-hr', A, '/leave/requests?status=bogus')).status).toBe(422);
  });
  it('balances: own, team, HR; strangers 404', async () => {
    expect((await call('get', 'lva-hr', A, `/leave/balances?employeeId=${empId}`)).status).toBe(200);
    expect((await call('get', 'lva-emp', A, `/leave/balances?employeeId=${otherBranchEmp}`)).status).toBe(404);
    expect((await call('get', 'lva-emp', A, '/leave/balances?employeeId=nope')).status).toBe(404);
  });
});

describe('ledger rules', () => {
  it('manual adjustment: permission, reason, overdraw guard', async () => {
    const body = { employeeId: empId, leaveTypeId: ids.cl, days: '1', effectiveDate: '2030-02-01', reason: 'goodwill' };
    expect((await call('post', 'lva-mgr', A, '/leave/balances/adjust', body)).status).toBe(403);
    expect((await call('post', 'lva-hr', A, '/leave/balances/adjust', { ...body, reason: 'x' })).status).toBe(422);
    expect((await call('post', 'lva-hr', A, '/leave/balances/adjust', { ...body, days: '0' })).status).toBe(422);
    expect((await call('post', 'lva-hr', A, '/leave/balances/adjust', { ...body, days: '-100' })).body.error.code).toBe('insufficient_balance');
  });
  it('adjust is idempotent per Idempotency-Key', async () => {
    const body = { employeeId: dualEmp, leaveTypeId: ids.cl, days: '2', effectiveDate: '2030-02-01', reason: 'retry-safe' };
    const send = async () => w.h.http().post('/leave/balances/adjust').set({ ...(await w.as('lva-hr', A)), 'Idempotency-Key': 'k-1' }).send(body);
    const before = Number((await call('get', 'lva-hr', A, `/leave/balances?employeeId=${dualEmp}`)).body.data.find((b: { leaveTypeCode: string }) => b.leaveTypeCode === 'CL').balanceDays);
    await send(); await send();
    const after = Number((await call('get', 'lva-hr', A, `/leave/balances?employeeId=${dualEmp}`)).body.data.find((b: { leaveTypeCode: string }) => b.leaveTypeCode === 'CL').balanceDays);
    expect(after - before).toBe(2);
  });
});

describe('accrual & year end', () => {
  it('accrual grants once per period (idempotent) and only to eligible employees', async () => {
    const C = await w.tenant('lv-c', 'lvc-root');
    await w.member(C, 'lvc-root-boot', 'lvc-hr', ['hr_admin']);
    const e1 = await w.employee(C, 'lvc-root-boot', null, { name: 'E1', joined: '2030-01-01' });
    await w.employee(C, 'lvc-root-boot', null, { name: 'E2', joined: '2030-01-01', status: 'onboarding' });
    await w.employee(C, 'lvc-root-boot', null, { name: 'E3', joined: '2031-01-20' });   // joined after as-of
    const t = (await call('post', 'lvc-hr', C, '/leave/types', { code: 'PL', name: 'Privilege' })).body.data.id;
    const p = (await call('post', 'lvc-hr', C, '/leave/policies', { leaveTypeId: t, effectiveFrom: '2030-01-01', accrualFrequency: 'monthly', accrualDays: '1.25', carryForwardMaxDays: '1' })).body.data.id;
    await call('post', 'lvc-hr', C, `/leave/policies/${p}/activate`);
    const run = () => call('post', 'lvc-hr', C, '/leave/accrual/run', { asOf: '2031-01-15' });
    expect((await run()).body.data.granted).toBe(1);
    expect((await run()).body.data.granted).toBe(0);
    expect((await call('post', 'lvc-hr', C, '/leave/accrual/run', { asOf: '2031-02-15' })).body.data.granted).toBe(2);
    const bal = (await w.admin.query(`SELECT SUM(days_delta)::text s FROM leave_balance_transactions WHERE employee_id=$1`, [e1])).rows[0].s;
    expect(bal).toBe('2.500');
    // year end: cap 1 -> e1 lapses 1.5, e3 lapses 0.25
    const ye = await call('post', 'lvc-hr', C, '/leave/year-end/run', { year: 2031 });
    expect(ye.body.data.lapsed).toBe(2);
    expect((await call('post', 'lvc-hr', C, '/leave/year-end/run', { year: 2031 })).body.data.lapsed).toBe(0);
    expect((await w.admin.query(`SELECT SUM(days_delta)::text s FROM leave_balance_transactions WHERE employee_id=$1`, [e1])).rows[0].s).toBe('1.000');
  });
  it('only policy managers can run them', async () => {
    expect((await call('post', 'lva-emp', A, '/leave/accrual/run', {})).status).toBe(403);
  });
});

describe('payroll lock', () => {
  it('approving leave into a locked attendance period is refused (HT006 -> 409)', async () => {
    const C = await w.tenant('lv-lock', 'lvl-root');
    await w.member(C, 'lvl-root-boot', 'lvl-hr', ['hr_admin']);
    await w.member(C, 'lvl-root-boot', 'lvl-emp', ['employee']);
    const e = await w.employee(C, 'lvl-root-boot', 'lvl-emp');
    const ty = (await call('post', 'lvl-hr', C, '/leave/types', { code: 'LOP', name: 'LOP', isPaid: false })).body.data.id;
    const client = await w.app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`, [C.id, w.users['lvl-root-boot']]);
      const pg = (await client.query(`INSERT INTO pay_groups (tenant_id, code, name) VALUES ($1,'PG','PG') RETURNING id`, [C.id])).rows[0].id;
      await client.query('UPDATE employees SET pay_group_id=$3 WHERE tenant_id=$1 AND id=$2', [C.id, e, pg]);
      await client.query(`INSERT INTO payroll_periods (tenant_id, pay_group_id, period_code, period_start, period_end, attendance_locked_at) VALUES ($1,$2,'2031-10','2031-10-01','2031-10-31', now())`, [C.id, pg]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    const r = await call('post', 'lvl-emp', C, '/leave/requests', { leaveTypeId: ty, startDate: '2031-10-06', endDate: '2031-10-06' });
    expect(r.status).toBe(201);
    const d = await call('post', 'lvl-hr', C, `/leave/requests/${r.body.data.id}/approve`, { version: 1 });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('period_locked');
    // and the request stayed pending (transaction rolled back as a whole)
    expect((await call('get', 'lvl-emp', C, `/leave/requests/${r.body.data.id}`)).body.data.status).toBe('pending');
  });
});
