import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let A: Tenant; let B: Tenant;
let empId: string; let emp2Id: string; let mgrEmpId: string; let otherId: string; let dualId: string;
const ids: Record<string, string> = {};
const call = async (m: 'get' | 'post' | 'patch', sub: string, t: Tenant, path: string, body?: object, o?: { mfa?: boolean }) =>
  w.h.http()[m](path).set(await w.as(sub, t, o)).send(body);
// IST = UTC+5:30. 2026-10-14 is a Wednesday, 2026-10-18 a Sunday.
const WED = '2026-10-14';

beforeAll(async () => {
  w = await createWorld();
  A = await w.tenant('at-a', 'ata-root');
  B = await w.tenant('at-b', 'atb-root');
  await w.member(A, 'ata-root-boot', 'ata-hr', ['hr_admin']);
  await w.member(A, 'ata-root-boot', 'ata-mgr', ['store_manager'], [A.branch]);
  await w.member(A, 'ata-root-boot', 'ata-emp', ['employee'], [A.branch]);
  await w.member(A, 'ata-root-boot', 'ata-emp2', ['employee'], [A.branch]);
  await w.member(A, 'ata-root-boot', 'ata-other', ['employee'], [A.branch2]);
  await w.member(A, 'ata-root-boot', 'ata-dual', ['hr_admin', 'payroll_approver'], [A.branch]);
  mgrEmpId = await w.employee(A, 'ata-root-boot', 'ata-mgr');
  empId = await w.employee(A, 'ata-root-boot', 'ata-emp', { manager: mgrEmpId });
  emp2Id = await w.employee(A, 'ata-root-boot', 'ata-emp2');
  otherId = await w.employee(A, 'ata-root-boot', 'ata-other', { branch: A.branch2 });
  dualId = await w.employee(A, 'ata-root-boot', 'ata-dual');

  const hr = (p: string, b: object) => call('post', 'ata-hr', A, p, b);
  ids.shift = (await hr('/attendance/shifts', { code: 'gen', name: 'General', startTime: '09:00', endTime: '18:00', graceMinutes: 10, weeklyOffDays: [0] })).body.data.id;
  for (const e of [empId, emp2Id, dualId, otherId, mgrEmpId]) await hr('/attendance/shift-assignments', { employeeId: e, shiftId: ids.shift, effectiveFrom: '2020-01-01' });
  const pol = await hr('/attendance/policies', { name: 'Default', effectiveFrom: '2020-01-01', allowEmployeeCheckin: true, lateMarksPerHalfDay: 3, correctionWindowDays: 7, overtimeEnabled: true, missingPunchPolicy: 'half_day' });
  await hr(`/attendance/policies/${pol.body.data.id}/activate`, {});
});
afterAll(() => w.close());

describe('shifts & assignments', () => {
  it('manage_policy only; code normalised; validation', async () => {
    expect((await call('post', 'ata-mgr', A, '/attendance/shifts', { code: 'x', name: 'Xx', startTime: '09:00', endTime: '17:00' })).status).toBe(403);
    const s = (await call('get', 'ata-emp', A, '/attendance/shifts')).body.data;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ code: 'GEN', startTime: '09:00', endTime: '18:00', crossesMidnight: false, weeklyOffDays: [0] });
    expect((await call('post', 'ata-hr', A, '/attendance/shifts', { code: 'bad', name: 'Bad', startTime: '25:00', endTime: '17:00' })).status).toBe(422);
    expect((await call('post', 'ata-hr', A, '/attendance/shifts', { code: 'bad', name: 'Bad', startTime: '09:00', endTime: '17:00', halfDayMinutes: 500, fullDayMinutes: 400 })).status).toBe(422);
    expect((await call('post', 'ata-hr', A, '/attendance/shifts', { code: 'gen', name: 'dup', startTime: '09:00', endTime: '17:00' })).status).toBe(409);
  });
  it('night shift crosses midnight; update changes weekly offs', async () => {
    const n = await call('post', 'ata-hr', A, '/attendance/shifts', { code: 'night', name: 'Night', startTime: '22:00', endTime: '06:00' });
    expect(n.body.data.crossesMidnight).toBe(true);
    const u = await call('patch', 'ata-hr', A, `/attendance/shifts/${n.body.data.id}`, { weeklyOffDays: [0, 6], graceMinutes: 5 });
    expect(u.body.data).toMatchObject({ weeklyOffDays: [0, 6], graceMinutes: 5 });
    expect((await call('patch', 'ata-hr', A, `/attendance/shifts/${n.body.data.id}`, {})).status).toBe(422);
  });
  it('assigning from a later date ends the current assignment the day before', async () => {
    const s2 = (await call('post', 'ata-hr', A, '/attendance/shifts', { code: 'late', name: 'Late', startTime: '12:00', endTime: '21:00' })).body.data.id;
    expect((await call('post', 'ata-hr', A, '/attendance/shift-assignments', { employeeId: emp2Id, shiftId: s2, effectiveFrom: '2031-01-01' })).status).toBe(201);
    const list = (await call('get', 'ata-hr', A, `/attendance/shift-assignments?employeeId=${emp2Id}`)).body.data;
    expect(list.map((x: { shiftCode: string; effectiveFrom: string; effectiveTo: string | null }) => [x.shiftCode, x.effectiveFrom, x.effectiveTo]))
      .toEqual([['LATE', '2031-01-01', null], ['GEN', '2020-01-01', '2030-12-31']]);
    // same-day reassignment supersedes instead of colliding
    expect((await call('post', 'ata-hr', A, '/attendance/shift-assignments', { employeeId: emp2Id, shiftId: ids.shift, effectiveFrom: '2031-01-01' })).status).toBe(201);
  });
  it('scope: out-of-branch assignment is 404, unknown shift 422', async () => {
    await w.member(A, 'ata-root-boot', 'ata-hrb', ['hr_admin'], [A.branch]);
    expect((await call('post', 'ata-hrb', A, '/attendance/shift-assignments', { employeeId: otherId, shiftId: ids.shift, effectiveFrom: '2027-01-01' })).status).toBe(404);
    expect((await call('post', 'ata-hr', A, '/attendance/shift-assignments', { employeeId: empId, shiftId: '11111111-1111-4111-8111-111111111111', effectiveFrom: '2027-01-01' })).status).toBe(422);
  });
});

describe('manual marking', () => {
  it('derives worked, late and overtime from times (IST shift)', async () => {
    const r = await call('post', 'ata-mgr', A, '/attendance/days/mark', { employeeId: empId, workDate: WED, checkInAt: '2026-10-14T03:45:00Z', checkOutAt: '2026-10-14T13:00:00Z', reason: 'forgot to punch' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'present', workedMinutes: 555, lateMinutes: 15, overtimeMinutes: 75, paidDayFraction: '1.000', source: 'manual', approvalStatus: 'approved' });
  });
  it('re-marking bumps correctionVersion; explicit status overrides derivation', async () => {
    const r = await call('post', 'ata-mgr', A, '/attendance/days/mark', { employeeId: empId, workDate: WED, status: 'half_day', reason: 'left early' });
    expect(r.body.data).toMatchObject({ status: 'half_day', paidDayFraction: '0.500', correctionVersion: 1 });
  });
  it('rejects future dates, missing payload, employees, and out-of-scope managers', async () => {
    expect((await call('post', 'ata-mgr', A, '/attendance/days/mark', { employeeId: empId, workDate: '2031-01-01', status: 'present', reason: 'future' })).status).toBe(422);
    expect((await call('post', 'ata-mgr', A, '/attendance/days/mark', { employeeId: empId, workDate: WED, reason: 'nothing' })).status).toBe(422);
    expect((await call('post', 'ata-emp', A, '/attendance/days/mark', { employeeId: empId, workDate: WED, status: 'present', reason: 'self' })).status).toBe(403);
    expect((await call('post', 'ata-mgr', A, '/attendance/days/mark', { employeeId: otherId, workDate: WED, status: 'present', reason: 'x y z' })).status).toBe(404);
    expect((await call('post', 'atb-root', B, '/attendance/days/mark', { employeeId: empId, workDate: WED, status: 'present', reason: 'x y z' })).status).toBe(404);
  });
  it('refuses to overwrite a day covered by approved leave', async () => {
    await w.admin.query(`INSERT INTO attendance_days (tenant_id, employee_id, work_date, attendance_status, paid_day_fraction, source, approval_status) VALUES ($1,$2,'2026-10-13','leave',1,'system','approved')`, [A.id, empId]);
    const r = await call('post', 'ata-mgr', A, '/attendance/days/mark', { employeeId: empId, workDate: '2026-10-13', status: 'present', reason: 'oops' });
    expect(r.status).toBe(409);
  });
});

describe('device import', () => {
  it('derives days, de-duplicates, and attaches an after-midnight check-out to the previous day', async () => {
    const ev = (employeeId: string, type: string, at: string, key: string) => ({ employeeId, type, occurredAt: at, idempotencyKey: key, deviceReference: 'dev-1' });
    const batch = {
      events: [
        ev(emp2Id, 'check_in', '2026-10-12T03:30:00Z', 'imp-key-0001'),   // 09:00 IST Mon 12th
        ev(emp2Id, 'check_out', '2026-10-12T12:30:00Z', 'imp-key-0002'),  // 18:00 IST
        ev(dualId, 'check_in', '2026-10-12T16:30:00Z', 'imp-key-0003'),   // 22:00 IST Mon 12th
        ev(dualId, 'check_out', '2026-10-12T22:30:00Z', 'imp-key-0004'),  // 04:00 IST Tue 13th
      ],
    };
    const first = await call('post', 'ata-hr', A, '/attendance/events/import', batch);
    expect(first.body.data).toEqual({ accepted: 4, duplicates: 0 });
    expect((await call('post', 'ata-hr', A, '/attendance/events/import', batch)).body.data).toEqual({ accepted: 0, duplicates: 4 });
    const days = (await call('get', 'ata-hr', A, '/attendance/days?from=2026-10-12&to=2026-10-13&limit=100')).body.data;
    const e2 = days.find((d: { employeeId: string; workDate: string }) => d.employeeId === emp2Id && d.workDate === '2026-10-12');
    expect(e2).toMatchObject({ status: 'present', workedMinutes: 540, lateMinutes: 0, source: 'device_import' });
    const night = days.find((d: { employeeId: string }) => d.employeeId === dualId);
    expect(night.workDate).toBe('2026-10-12');
    expect(night.workedMinutes).toBe(360);
    expect(days.filter((d: { employeeId: string }) => d.employeeId === dualId)).toHaveLength(1);
  });
  it('is permission and scope checked as a whole', async () => {
    const bad = { events: [{ employeeId: otherId, type: 'check_in', occurredAt: '2026-10-12T03:30:00Z', idempotencyKey: 'imp-key-9999' }] };
    expect((await call('post', 'ata-mgr', A, '/attendance/events/import', bad)).status).toBe(404);
    expect((await call('post', 'ata-emp', A, '/attendance/events/import', bad)).status).toBe(403);
    expect((await call('post', 'ata-hr', A, '/attendance/events/import', { events: [] })).status).toBe(422);
  });
});

describe('employee self check-in', () => {
  it('check-in, double check-in refused, check-out computes the day', async () => {
    const out0 = await call('post', 'ata-emp2', A, '/attendance/check-out');
    expect(out0.status).toBe(409);
    const i = await call('post', 'ata-emp2', A, '/attendance/check-in');
    expect(i.status).toBe(200);
    expect(i.body.data).toMatchObject({ status: 'present', source: 'employee_checkin', checkOutAt: null });
    expect((await call('post', 'ata-emp2', A, '/attendance/check-in')).status).toBe(409);
    const o = await call('post', 'ata-emp2', A, '/attendance/check-out');
    expect(o.status).toBe(200);
    expect(o.body.data.checkOutAt).not.toBeNull();
    expect((await call('post', 'ata-emp2', A, '/attendance/check-out')).status).toBe(409);
  });
  it('is refused when the company has not enabled it, and for users without an employee record', async () => {
    await w.member(B, 'atb-root-boot', 'atb-emp', ['employee']);
    await w.employee(B, 'atb-root-boot', 'atb-emp');
    const off = await call('post', 'atb-emp', B, '/attendance/check-in');            // no policy in B => self check-in disabled
    expect(off.status).toBe(409);
    expect(off.body.error.message).toMatch(/not enabled/);
    expect((await call('post', 'ata-root', A, '/attendance/check-in')).status).toBe(422);   // permitted, but no employee profile
  });
});

describe('corrections', () => {
  let corrId: string;
  it('employee requests a correction within the window; duplicates and stale dates refused', async () => {
    const r = await call('post', 'ata-emp', A, '/attendance/corrections', { workDate: '2026-10-19', requested: { status: 'present', checkInAt: '2026-10-19T03:30:00Z', checkOutAt: '2026-10-19T12:30:00Z' }, reason: 'device was down' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'pending', employeeId: empId, workDate: '2026-10-19', previous: { status: 'not_marked' } });
    corrId = r.body.data.id;
    expect((await call('post', 'ata-emp', A, '/attendance/corrections', { workDate: '2026-10-19', requested: { status: 'absent' }, reason: 'again' })).status).toBe(409);
    expect((await call('post', 'ata-emp', A, '/attendance/corrections', { workDate: '2026-08-01', requested: { status: 'present' }, reason: 'too old' })).status).toBe(422);
    expect((await call('post', 'ata-emp', A, '/attendance/corrections', { workDate: '2031-01-01', requested: { status: 'present' }, reason: 'future' })).status).toBe(422);
  });
  it('employee cannot approve; other employees cannot see it; manager can', async () => {
    expect((await call('post', 'ata-emp', A, `/attendance/corrections/${corrId}/approve`, {})).status).toBe(403);
    expect((await call('get', 'ata-emp2', A, '/attendance/corrections')).body.data.some((c: { id: string }) => c.id === corrId)).toBe(false);
    expect((await call('get', 'ata-mgr', A, '/attendance/corrections?status=pending')).body.data.some((c: { id: string }) => c.id === corrId)).toBe(true);
    expect((await call('get', 'ata-emp', A, '/attendance/corrections?status=bogus')).status).toBe(422);
  });
  it('manager approves: the day is updated and versioned; cannot be reviewed twice', async () => {
    const r = await call('post', 'ata-mgr', A, `/attendance/corrections/${corrId}/approve`, { comment: 'ok' });
    expect(r.body.data).toMatchObject({ status: 'approved', reviewComment: 'ok' });
    const d = (await call('get', 'ata-emp', A, '/attendance/days?from=2026-10-19&to=2026-10-19')).body.data[0];
    expect(d).toMatchObject({ status: 'present', workedMinutes: 540, correctionVersion: 1, source: 'manual' });
    expect((await call('post', 'ata-mgr', A, `/attendance/corrections/${corrId}/approve`, {})).status).toBe(409);
  });
  it('rejection needs a reason; requester can cancel their own pending request', async () => {
    const r = await call('post', 'ata-emp', A, '/attendance/corrections', { workDate: '2026-10-20', requested: { status: 'work_from_home' }, reason: 'wfh day' });
    expect((await call('post', 'ata-mgr', A, `/attendance/corrections/${r.body.data.id}/reject`, {})).status).toBe(422);
    expect((await call('post', 'ata-emp2', A, `/attendance/corrections/${r.body.data.id}/cancel`, {})).status).toBe(404);
    const cx = await call('post', 'ata-emp', A, `/attendance/corrections/${r.body.data.id}/cancel`, {});
    expect(cx.body.data.status).toBe('cancelled');
  });
  it('maker-checker: a reviewer cannot approve their own correction', async () => {
    const r = await call('post', 'ata-dual', A, '/attendance/corrections', { workDate: '2026-10-20', requested: { status: 'present' }, reason: 'forgot punch' });
    expect(r.status).toBe(201);
    const d = await call('post', 'ata-dual', A, `/attendance/corrections/${r.body.data.id}/approve`, {});
    expect(d.status).toBe(403);
    expect(d.body.error.code).toBe('maker_checker_violation');
    expect((await call('post', 'ata-hr', A, `/attendance/corrections/${r.body.data.id}/approve`, {})).status).toBe(200);
  });
  it('managers can request on behalf of in-scope employees only', async () => {
    expect((await call('post', 'ata-hr', A, '/attendance/corrections', { employeeId: emp2Id, workDate: '2026-10-21', requested: { status: 'present' }, reason: 'on behalf' })).status).toBe(201);
    expect((await call('post', 'ata-mgr', A, '/attendance/corrections', { employeeId: otherId, workDate: '2026-10-21', requested: { status: 'present' }, reason: 'on behalf' })).status).toBe(404);
  });
});

describe('daily close', () => {
  it('creates absent / weekly_off / holiday rows and applies the missing-punch policy once', async () => {
    const C = await w.tenant('at-c', 'atc-root');
    await w.member(C, 'atc-root-boot', 'atc-hr', ['hr_admin']);
    const e1 = await w.employee(C, 'atc-root-boot', null, { name: 'E1', joined: '2020-01-01' });
    const e2 = await w.employee(C, 'atc-root-boot', null, { name: 'E2', joined: '2020-01-01' });
    await w.employee(C, 'atc-root-boot', null, { name: 'E3', joined: '2026-11-01' });     // not yet joined
    const p = (await call('post', 'atc-hr', C, '/attendance/policies', { name: 'Pol', effectiveFrom: '2020-01-01', missingPunchPolicy: 'flag' })).body.data.id;
    await call('post', 'atc-hr', C, `/attendance/policies/${p}/activate`);
    await call('post', 'atc-hr', C, '/holidays', { holidayDate: '2026-10-20', name: 'Local holiday' });
    // e2 has an open punch on Monday the 19th
    await call('post', 'atc-hr', C, '/attendance/events/import', { events: [{ employeeId: e2, type: 'check_in', occurredAt: '2026-10-19T03:30:00Z', idempotencyKey: 'close-key-0001' }] });
    const run = (date: string) => call('post', 'atc-hr', C, '/attendance/finalize', { date });
    expect((await run('2026-10-22')).status).toBe(422);                                   // not a past day
    expect((await run('2026-10-18')).body.data).toMatchObject({ created: 2, closed: 0 }); // Sunday
    expect((await run('2026-10-18')).body.data).toMatchObject({ created: 0, closed: 0 }); // idempotent
    expect((await run('2026-10-19')).body.data).toMatchObject({ created: 1, closed: 1 }); // Monday: e1 absent, e2 closed
    expect((await run('2026-10-20')).body.data).toMatchObject({ created: 2 });            // holiday
    const rows = (await w.admin.query(`SELECT employee_id, to_char(work_date,'YYYY-MM-DD') d, attendance_status s, approval_status a FROM attendance_days WHERE tenant_id=$1 ORDER BY d, employee_id`, [C.id])).rows;
    expect(rows.filter((r) => r.d === '2026-10-18').map((r) => r.s)).toEqual(['weekly_off', 'weekly_off']);
    expect(rows.find((r) => r.d === '2026-10-19' && r.employee_id === e1)).toMatchObject({ s: 'absent' });
    expect(rows.find((r) => r.d === '2026-10-19' && r.employee_id === e2)).toMatchObject({ s: 'present', a: 'pending' });   // flagged for review
    expect(rows.filter((r) => r.d === '2026-10-20').map((r) => r.s)).toEqual(['holiday', 'holiday']);
  });
});

describe('payroll cut-off lock', () => {
  it('blocks while reviews are pending, needs MFA, then freezes the period', async () => {
    const C = await w.tenant('at-l', 'atl-root');
    await w.member(C, 'atl-root-boot', 'atl-hr', ['hr_admin']);
    await w.member(C, 'atl-root-boot', 'atl-fin', ['finance_payroll']);
    const e = await w.employee(C, 'atl-root-boot', null, { name: 'E', joined: '2020-01-01' });
    const pol = (await call('post', 'atl-hr', C, '/attendance/policies', { name: 'Pol', effectiveFrom: '2020-01-01', missingPunchPolicy: 'flag' })).body.data.id;
    await call('post', 'atl-hr', C, `/attendance/policies/${pol}/activate`);
    const client = await w.app.connect();
    let period: string; let live: string;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.user_id',$2,true)`, [C.id, w.users['atl-root-boot']]);
      const pg = (await client.query(`INSERT INTO pay_groups (tenant_id, code, name) VALUES ($1,'PG','PG') RETURNING id`, [C.id])).rows[0].id;
      await client.query('UPDATE employees SET pay_group_id=$3 WHERE tenant_id=$1 AND id=$2', [C.id, e, pg]);
      period = (await client.query(`INSERT INTO payroll_periods (tenant_id, pay_group_id, period_code, period_start, period_end) VALUES ($1,$2,'2026-09','2026-09-01','2026-09-30') RETURNING id`, [C.id, pg])).rows[0].id;
      live = (await client.query(`INSERT INTO payroll_periods (tenant_id, pay_group_id, period_code, period_start, period_end) VALUES ($1,$2,'2026-10','2026-10-01','2026-10-31') RETURNING id`, [C.id, pg])).rows[0].id;
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }

    // a flagged (pending) day inside September
    await call('post', 'atl-hr', C, '/attendance/events/import', { events: [{ employeeId: e, type: 'check_in', occurredAt: '2026-09-10T03:30:00Z', idempotencyKey: 'lock-key-0001' }] });
    await call('post', 'atl-hr', C, '/attendance/finalize', { date: '2026-09-10' });
    expect((await call('post', 'atl-fin', C, '/attendance/lock', { periodId: period }, { mfa: true })).status).toBe(409);
    // reviewer resolves it
    await call('post', 'atl-hr', C, '/attendance/days/mark', { employeeId: e, workDate: '2026-09-10', status: 'present', reason: 'verified' });

    expect((await call('post', 'atl-fin', C, '/attendance/lock', { periodId: period })).body.error.code).toBe('mfa_required');
    expect((await call('post', 'atl-hr', C, '/attendance/lock', { periodId: period }, { mfa: true })).status).toBe(403);
    expect((await call('post', 'atl-fin', C, '/attendance/lock', { periodId: live }, { mfa: true })).status).toBe(409);       // period not ended
    const ok = await call('post', 'atl-fin', C, '/attendance/lock', { periodId: period }, { mfa: true });
    expect(ok.status).toBe(200);
    expect((await call('post', 'atl-fin', C, '/attendance/lock', { periodId: period }, { mfa: true })).status).toBe(409);       // already locked
    const frozen = await call('post', 'atl-hr', C, '/attendance/days/mark', { employeeId: e, workDate: '2026-09-10', status: 'absent', reason: 'late change' });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe('period_locked');
    expect((await call('post', 'atl-hr', C, '/attendance/days/mark', { employeeId: e, workDate: '2026-10-05', status: 'present', reason: 'open period ok' })).status).toBe(200);
  });
});

describe('reading & summary', () => {
  it('scope: own, team/branch, all; window and cursor validation', async () => {
    const mine = (await call('get', 'ata-emp', A, '/attendance/days?from=2026-10-01&to=2026-10-31&limit=100')).body.data;
    expect(mine.every((d: { employeeId: string }) => d.employeeId === empId)).toBe(true);
    const mgr = (await call('get', 'ata-mgr', A, '/attendance/days?from=2026-10-01&to=2026-10-31&limit=200')).body.data;
    expect(mgr.some((d: { employeeId: string }) => d.employeeId === otherId)).toBe(false);
    const all = await call('get', 'ata-hr', A, '/attendance/days?from=2026-10-01&to=2026-10-31&limit=2');
    expect(all.body.data).toHaveLength(2);
    const next = await call('get', 'ata-hr', A, `/attendance/days?from=2026-10-01&to=2026-10-31&limit=2&cursor=${all.body.page.nextCursor}`);
    expect(next.body.data.map((d: { id: string }) => d.id)).not.toContain(all.body.data[0].id);
    expect((await call('get', 'ata-hr', A, '/attendance/days?from=2026-01-01&to=2026-12-31')).status).toBe(422);
    expect((await call('get', 'ata-hr', A, '/attendance/days?from=2026-10-01&to=2026-10-05&cursor=nonsense')).status).toBe(422);
    expect((await call('get', 'atb-root', B, '/attendance/days?from=2026-10-01&to=2026-10-31')).body.data).toEqual([]);
  });
  it('monthly summary computes paid days, late marks and deduction', async () => {
    const s = await call('get', 'ata-hr', A, `/attendance/summary?month=2026-10&employeeId=${empId}`);
    expect(s.status).toBe(200);
    expect(s.body.data).toMatchObject({ employeeId: empId, month: '2026-10' });
    expect(Number(s.body.data.paidDays) + Number(s.body.data.unpaidDays)).toBe(31);
    expect((await call('get', 'ata-emp', A, `/attendance/summary?month=2026-10&employeeId=${otherId}`)).status).toBe(404);
    expect((await call('get', 'ata-emp', A, '/attendance/summary?month=2026-13')).status).toBe(422);
  });
});
