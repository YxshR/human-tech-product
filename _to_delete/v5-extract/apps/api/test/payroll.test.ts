import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';
import { csvCell } from '../src/payroll/payroll.service';

let w: World; let P: Tenant; let Q: Tenant;
let e1: string; let e2: string; let e3: string;
const ids: Record<string, string> = {};
const call = async (m: 'get' | 'post' | 'patch' | 'put', sub: string, t: Tenant, path: string, body?: object, mfa = true) => w.h.http()[m](path).set(await w.as(sub, t, { mfa })).send(body);
const fin = (m: 'get' | 'post' | 'patch' | 'put', p: string, b?: object) => call(m, 'pf-fin', P, p, b);
const appr = (m: 'get' | 'post' | 'patch' | 'put', p: string, b?: object) => call(m, 'pf-appr', P, p, b);
const both = (m: 'get' | 'post' | 'patch' | 'put', p: string, b?: object) => call(m, 'pf-both', P, p, b);

beforeAll(async () => {
  w = await createWorld();
  P = await w.tenant('pf-a', 'pfa-root'); Q = await w.tenant('pf-b', 'pfb-root');
  await w.member(P, 'pfa-root-boot', 'pf-fin', ['finance_payroll']);
  await w.member(P, 'pfa-root-boot', 'pf-appr', ['payroll_approver']);
  await w.member(P, 'pfa-root-boot', 'pf-both', ['finance_payroll', 'payroll_approver']);
  await w.member(P, 'pfa-root-boot', 'pf-hr', ['hr_admin']);
  await w.member(P, 'pfa-root-boot', 'pf-e1', ['employee'], [P.branch]);
  await w.member(P, 'pfa-root-boot', 'pf-e2', ['employee'], [P.branch]);
  await w.member(Q, 'pfb-root-boot', 'pfq-fin', ['finance_payroll']);
  e1 = await w.employee(P, 'pfa-root-boot', 'pf-e1', { joined: '2020-01-01', name: 'Asha' });
  e2 = await w.employee(P, 'pfa-root-boot', 'pf-e2', { joined: '2020-01-01', name: 'Bala' });
  e3 = await w.employee(P, 'pfa-root-boot', null, { joined: '2020-01-01', name: 'Chitra' });
});
afterAll(() => w.close());

const approveRule = async () => {
  await w.system.query(
    `INSERT INTO statutory_rule_sets (rule_group, version, effective_from, definition, source_url, status, prepared_by, reviewed_by, reviewed_at)
     VALUES ('pf', 1, '2020-01-01', $1, 'https://example.test/pf-rule', 'approved', $2, $3, now())`,
    [JSON.stringify({ kind: 'percentage', rate: '0.12', baseCodes: ['BASIC'], baseCeiling: '15000' }), w.users['pf-fin'], w.users['pf-appr']]);
};
const toFinal = async (runId: string, maker: typeof fin, checker: typeof appr) => {
  expect((await maker('post', `/payroll/runs/${runId}/validate`)).body.data.run.status).toBe('validated');
  expect((await maker('post', `/payroll/runs/${runId}/calculate`)).body.data.status).toBe('calculated');
  expect((await maker('post', `/payroll/runs/${runId}/submit`)).body.data.status).toBe('under_review');
  expect((await checker('post', `/payroll/runs/${runId}/approve`)).body.data.status).toBe('approved');
  return checker('post', `/payroll/runs/${runId}/finalize`);
};

describe('activation & setup', () => {
  it('cannot create runs until the platform activates payroll; requesting is idempotent', async () => {
    expect((await fin('get', '/payroll/status')).body.data).toMatchObject({ activated: false, activationRequestedAt: null, makerCheckerRequired: true });
    const r1 = await fin('post', '/payroll/activation-request'); const r2 = await fin('post', '/payroll/activation-request');
    expect(r1.status).toBe(200); expect(r2.body.data.activationRequestedAt).toBe(r1.body.data.activationRequestedAt);
    expect((await call('post', 'pf-hr', P, '/payroll/activation-request')).status).toBe(403);

    ids.g = (await fin('post', '/payroll/pay-groups', { code: 'mth', name: 'Monthly staff' })).body.data.id;
    ids.fp = (await fin('post', '/payroll/pay-groups', { code: 'fp', name: 'Full pay', attendanceSource: 'full_pay' })).body.data.id;
    expect((await fin('post', '/payroll/pay-groups', { code: 'MTH', name: 'Dup' })).status).toBe(409);
    ids.p = (await fin('post', '/payroll/periods/generate', { payGroupId: ids.g, month: '2026-09' })).body.data.id;
    const per = (await fin('get', `/payroll/periods?payGroupId=${ids.g}`)).body.data[0];
    expect(per).toMatchObject({ periodCode: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30', status: 'open' });
    expect((await fin('post', '/payroll/periods/generate', { payGroupId: ids.g, month: '2026-09' })).status).toBe(409);
    const run = await fin('post', '/payroll/runs', { payrollPeriodId: ids.p });
    expect(run.status).toBe(409); expect(run.body.error.message).toMatch(/not been activated/);
    await w.system.query('UPDATE tenants SET payroll_activated_at=now() WHERE id=$1', [P.id]);
    expect((await fin('post', '/payroll/activation-request')).status).toBe(409);
    expect((await fin('get', '/payroll/status')).body.data.activated).toBe(true);
  });
  it('pay setup rules', async () => {
    for (const e of [e1, e2]) expect((await fin('put', `/payroll/employees/${e}/pay-setup`, { payGroupId: ids.g, payrollEligible: true })).status).toBe(200);
    expect((await fin('put', `/payroll/employees/${e3}/pay-setup`, { payGroupId: ids.fp, payrollEligible: true })).status).toBe(200);
    expect((await fin('put', `/payroll/employees/${e3}/pay-setup`, { payGroupId: null, payrollEligible: true })).status).toBe(422);
    expect((await call('put', 'pf-hr', P, `/payroll/employees/${e1}/pay-setup`, { payGroupId: ids.g, payrollEligible: true })).status).toBe(403);
  });
});

describe('September run, end to end', () => {
  it('validation blocks until salaries are assigned and attendance is locked', async () => {
    ids.run = (await fin('post', '/payroll/runs', { payrollPeriodId: ids.p })).body.data.id;
    expect((await fin('post', '/payroll/runs', { payrollPeriodId: ids.p })).status).toBe(409); // one in flight
    const v = await fin('post', `/payroll/runs/${ids.run}/validate`);
    expect(v.body.data.run.status).toBe('draft');
    const codes = v.body.data.exceptions.map((x: { code: string }) => x.code).sort();
    expect(codes).toEqual(['ATTENDANCE_NOT_LOCKED', 'NO_SALARY_ASSIGNMENT', 'NO_SALARY_ASSIGNMENT']);
    expect((await fin('post', `/payroll/runs/${ids.run}/calculate`)).status).toBe(409);
  });

  it('compensation set-up with maker-checker', async () => {
    const mk = async (code: string, type: string, version: object) => {
      const c = await fin('post', '/compensation/components', { code, label: code, componentType: type });
      const v = await fin('post', `/compensation/components/${c.body.data.id}/versions`, { effectiveFrom: '2020-01-01', ...version });
      await fin('post', `/compensation/component-versions/${v.body.data.id}/activate`);
      ids[code] = c.body.data.id; return v.body.data.id as string;
    };
    const basic = await mk('BASIC', 'earning', { calculationMethod: 'fixed', defaultAmount: '20000' });
    const hra = await mk('HRA', 'earning', { calculationMethod: 'percentage_of_component', baseComponentCodes: ['BASIC'], defaultPercentage: '40' });
    const spl = await mk('SPECIAL', 'earning', { calculationMethod: 'fixed', configuration: { balance: true } });
    const pf = await mk('PF_EE', 'employee_deduction', { calculationMethod: 'statutory', statutoryGroup: 'pf', prorateOnUnpaidDays: false });
    await mk('BONUS', 'earning', { calculationMethod: 'fixed', defaultAmount: '0' });
    const st = await fin('post', '/compensation/structures', { code: 'STD', name: 'Standard', effectiveFrom: '2020-01-01', components: [
      { componentVersionId: basic, displayOrder: 1 }, { componentVersionId: hra, displayOrder: 2 }, { componentVersionId: spl, displayOrder: 3 }, { componentVersionId: pf, displayOrder: 10 }] });
    expect((await fin('post', `/compensation/structures/${st.body.data.id}/activate`)).status).toBe(200);
    for (const [emp, ctc] of [[e1, '50000'], [e2, '50000'], [e3, '30000']] as const) {
      const a = await fin('post', '/compensation/assignments', { employeeId: emp, salaryStructureId: st.body.data.id, effectiveFrom: '2020-01-01', monthlyCtc: ctc, changeReason: 'Initial salary' });
      expect((await appr('post', `/compensation/assignments/${a.body.data.id}/approve`, {})).status).toBe(200);
    }
  });

  it('attendance is locked, adjustments flow through maker-checker', async () => {
    const rows: string[] = [];
    for (let d = 1; d <= 30; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      rows.push(`('${P.id}','${e1}','${date}','present',1)`);
      rows.push(`('${P.id}','${e2}','${date}','${d > 26 ? 'absent' : 'present'}',${d > 26 ? 0 : 1})`);
    }
    await w.admin.query(`INSERT INTO attendance_days (tenant_id, employee_id, work_date, attendance_status, paid_day_fraction) VALUES ${rows.join(',')}`);
    expect((await fin('post', '/attendance/lock', { periodId: ids.p })).status).toBe(200);

    const adj = await fin('post', '/payroll/adjustments', { employeeId: e1, payrollPeriodId: ids.p, componentId: ids.BONUS, kind: 'earning', amount: '1000.00', reason: 'Festival bonus' });
    expect(adj.status).toBe(201); ids.adj = adj.body.data.id;
    expect((await fin('post', `/payroll/adjustments/${ids.adj}/approve`, {})).status).toBe(403);     // no permission
    expect((await both('post', '/payroll/adjustments', { employeeId: e2, payrollPeriodId: ids.p, componentId: ids.BONUS, kind: 'deduction', amount: '5', reason: 'wrong type' })).status).toBe(422);
    const own = await both('post', '/payroll/adjustments', { employeeId: e2, payrollPeriodId: ids.p, componentId: ids.BONUS, kind: 'earning', amount: '5.00', reason: 'self approve test' });
    expect((await both('post', `/payroll/adjustments/${own.body.data.id}/approve`, {})).body.error.code).toBe('maker_checker_violation');
    expect((await appr('post', `/payroll/adjustments/${own.body.data.id}/reject`, {})).body.data.status).toBe('rejected');

    const v = await fin('post', `/payroll/runs/${ids.run}/validate`);
    expect(v.body.data.run.status).toBe('validated');
    expect(v.body.data.exceptions.map((x: { code: string }) => x.code)).toEqual(['UNAPPROVED_ADJUSTMENTS']);
    expect((await fin('post', `/payroll/runs/${ids.run}/validate`)).status).toBe(409);
  });

  it('a missing statutory rule shows up as a blocking calculation exception', async () => {
    expect((await appr('post', `/payroll/adjustments/${ids.adj}/approve`, {})).status).toBe(200);

    const calc = await fin('post', `/payroll/runs/${ids.run}/calculate`);
    expect(calc.status).toBe(200); expect(calc.body.data.openBlocking).toBe(2);
    const ex = (await fin('get', `/payroll/runs/${ids.run}/exceptions`)).body.data;
    expect(ex.filter((x: { code: string }) => x.code === 'NO_APPROVED_RULE')).toHaveLength(2);
    expect((await fin('post', `/payroll/runs/${ids.run}/submit`)).status).toBe(200);
    const ap = await appr('post', `/payroll/runs/${ids.run}/approve`);
    expect(ap.status).toBe(409); expect(ap.body.error.message).toMatch(/blocking exception/);
    expect((await appr('post', `/payroll/runs/${ids.run}/reject`, { reason: 'no PF rule yet' })).body.data.status).toBe('rejected');
    expect((await fin('post', `/payroll/runs/${ids.run}/reopen`)).body.data.status).toBe('draft');
    expect((await w.admin.query(`SELECT status FROM payroll_adjustments WHERE id=$1`, [ids.adj])).rows[0].status).toBe('approved');
  });

  it('calculates the golden figures once the rule is approved', async () => {
    await approveRule();
    expect((await fin('post', `/payroll/runs/${ids.run}/validate`)).body.data.run.status).toBe('validated');
    const calc = await fin('post', `/payroll/runs/${ids.run}/calculate`);
    expect(calc.body.data.status).toBe('calculated'); expect(calc.body.data.openBlocking).toBe(0);
    expect(calc.body.data.totals).toEqual({ gross: '94333.33', employeeDeductions: '3600.00', employerContributions: '0.00', netPay: '90733.33' });
    const items = (await fin('get', `/payroll/runs/${ids.run}/items`)).body.data;
    expect(items.map((i: { employeeId: string }) => i.employeeId)).toEqual([e1, e2]);
    expect(items[0]).toMatchObject({ workingDays: '30.00', paidDays: '30.00', grossEarnings: '51000.00', employeeDeductions: '1800.00', netPay: '49200.00' });
    expect(items[1]).toMatchObject({ paidDays: '26.00', unpaidDays: '4.00', grossEarnings: '43333.33', employeeDeductions: '1800.00', netPay: '41533.33' });
    const detail = (await fin('get', `/payroll/runs/${ids.run}/items/${items[1].id}`)).body.data;
    expect(detail.lines.map((l: { componentCode: string; amount: string }) => `${l.componentCode}=${l.amount}`)).toEqual(['BASIC=17333.33', 'HRA=6933.33', 'SPECIAL=19066.67', 'PF_EE=1800.00']);
    expect(detail.lines[3].trace.length).toBeGreaterThan(0);
    const adj = (await fin('get', `/payroll/adjustments?periodId=${ids.p}`)).body.data.find((x: { id: string }) => x.id === ids.adj);
    expect(adj.status).toBe('applied');
    const paged = await fin('get', `/payroll/runs/${ids.run}/items?limit=1`);
    expect(paged.body.data).toHaveLength(1); expect(paged.body.page.nextCursor).toBeTruthy();
    const next = await fin('get', `/payroll/runs/${ids.run}/items?limit=1&cursor=${encodeURIComponent(paged.body.page.nextCursor)}`);
    expect(next.body.data[0].employeeId).toBe(e2); expect(next.body.page.nextCursor).toBeNull();
  });

  it('follows the state machine to finalisation', async () => {
    expect((await fin('post', `/payroll/runs/${ids.run}/calculate`)).status).toBe(409);
    expect((await fin('post', `/payroll/runs/${ids.run}/approve`)).status).toBe(403);
    expect((await fin('post', `/payroll/runs/${ids.run}/finalize`)).status).toBe(403);
    expect((await fin('post', `/payroll/runs/${ids.run}/submit`)).status).toBe(200);
    expect((await fin('post', `/payroll/runs/${ids.run}/reopen`)).status).toBe(409);
    expect((await appr('post', `/payroll/runs/${ids.run}/finalize`)).status).toBe(409);
    expect((await call('post', 'pf-appr', P, `/payroll/runs/${ids.run}/approve`, undefined, false)).body.error.code).toBe('mfa_required');
    expect((await appr('post', `/payroll/runs/${ids.run}/approve`)).body.data.status).toBe('approved');
    const f = await appr('post', `/payroll/runs/${ids.run}/finalize`);
    expect(f.status).toBe(200); expect(f.body.data.status).toBe('payslips_generated'); expect(f.body.data.lockedBy).toBe(w.users['pf-appr']);
    expect((await fin('get', `/payroll/periods?payGroupId=${ids.g}`)).body.data[0].status).toBe('closed');
    expect((await fin('post', `/payroll/runs/${ids.run}/reopen`)).status).toBe(409);
    expect((await fin('post', '/payroll/runs', { payrollPeriodId: ids.p })).status).toBe(409);
    // finalised data is immutable at the database level too
    await expect(w.admin.query(`UPDATE payroll_run_items SET net_pay = net_pay WHERE payroll_run_id=$1`, [ids.run])).rejects.toMatchObject({ code: 'HT002' });
  });

  it('issues payslips to employees only', async () => {
    const mine = await call('get', 'pf-e1', P, '/me/payslips');
    expect(mine.body.data).toHaveLength(1); expect(mine.body.data[0]).toMatchObject({ periodCode: '2026-09', netPay: '49200.00', revision: 1 });
    const slip = await call('get', 'pf-e1', P, `/me/payslips/${mine.body.data[0].id}`);
    expect(slip.body.data).toMatchObject({ employeeName: 'Asha', grossEarnings: '51000.00', totalDeductions: '1800.00', netPay: '49200.00', paidDays: '30.00' });
    expect(slip.body.data.earnings.map((l: { code: string }) => l.code)).toEqual(['BASIC', 'HRA', 'SPECIAL', 'BONUS']);
    const other = (await call('get', 'pf-e2', P, '/me/payslips')).body.data[0].id;
    expect((await call('get', 'pf-e1', P, `/me/payslips/${other}`)).status).toBe(404);
    expect((await call('get', 'pf-hr', P, `/payroll/payslips/${other}`)).status).toBe(404);
    expect((await fin('get', `/payroll/payslips/${other}`)).status).toBe(200);
    expect((await fin('get', `/payroll/runs/${ids.run}/payslips`)).body.data).toHaveLength(2);
    expect((await call('get', 'pf-e1', P, `/payroll/runs/${ids.run}`)).status).toBe(403);
  });

  it('exports a CSV register with formula injection neutralised', async () => {
    await w.admin.query(`UPDATE employees SET first_name = $2 WHERE id=$1`, [e2, `=HYPERLINK("http://evil.test","x")`]);
    const res = await fin('get', `/payroll/runs/${ids.run}/register?format=csv`);
    expect(res.status).toBe(200); expect(res.headers['content-type']).toMatch(/text\/csv/); expect(res.headers['content-disposition']).toMatch(/payroll-register-2026-09-r1\.csv/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toContain('BASIC (earning)'); expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")`);
    expect(lines[1].endsWith('51000.00,1800.00,0.00,49200.00')).toBe(true);
    expect((await call('get', 'pf-hr', P, `/payroll/runs/${ids.run}/register`)).status).toBe(403);
    expect((await fin('get', `/payroll/runs/${ids.run}/register?format=xml`)).status).toBe(422);
    expect((await fin('get', `/payroll/runs/${ids.run}/register?format=json`)).body.data).toHaveLength(2);
    expect((await w.admin.query(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='payroll_register.export'`, [P.id])).rowCount).toBe(2);
  });

  it('csvCell', () => {
    expect(csvCell('=1+1')).toBe(`'=1+1`); expect(csvCell('+91 98')).toBe(`'+91 98`); expect(csvCell('@sum')).toBe(`'@sum`); expect(csvCell('-cmd')).toBe(`'-cmd`);
    expect(csvCell('-1500.00')).toBe('-1500.00'); expect(csvCell('a,b')).toBe('"a,b"'); expect(csvCell('say "hi"')).toBe('"say ""hi"""'); expect(csvCell('plain')).toBe('plain');
  });

  it('a correction revision supersedes the earlier payslips and keeps adjustments', async () => {
    expect((await fin('post', `/payroll/runs/${ids.run}/correct`, { reason: 'short' })).status).toBe(422);
    const c = await fin('post', `/payroll/runs/${ids.run}/correct`, { reason: 'Re-run after policy review' });
    expect(c.status).toBe(201); expect(c.body.data).toMatchObject({ revision: 2, runKind: 'correction', status: 'draft', correctionOfRunId: ids.run });
    expect((await fin('post', `/payroll/runs/${ids.run}/correct`, { reason: 'Second correction attempt' })).status).toBe(409);
    const f = await toFinal(c.body.data.id, fin, appr);
    expect(f.body.data.status).toBe('payslips_generated');
    expect(f.body.data.totals).toEqual({ gross: '94333.33', employeeDeductions: '3600.00', employerContributions: '0.00', netPay: '90733.33' });
    const mine = (await call('get', 'pf-e1', P, '/me/payslips')).body.data;
    expect(mine.map((s: { revision: number; status: string }) => `${s.revision}:${s.status}`)).toEqual(['2:pending', '1:superseded']);
  });
});

describe('full-pay group and maker-checker', () => {
  it('the preparer cannot approve their own run, another approver can', async () => {
    const per = (await fin('post', '/payroll/periods/generate', { payGroupId: ids.fp, month: '2026-07' })).body.data.id;
    const run = (await both('post', '/payroll/runs', { payrollPeriodId: per })).body.data.id;
    expect((await both('post', `/payroll/runs/${run}/validate`)).body.data.run.status).toBe('validated');
    const calc = await both('post', `/payroll/runs/${run}/calculate`);
    expect(calc.body.data.totals).toMatchObject({ gross: '30000.00', netPay: '28200.00' });
    expect((await fin('get', `/payroll/runs/${run}/items`)).body.data[0]).toMatchObject({ workingDays: '31.00', paidDays: '31.00' });
    expect((await both('post', `/payroll/runs/${run}/submit`)).status).toBe(200);
    const self = await both('post', `/payroll/runs/${run}/approve`);
    expect(self.status).toBe(403); expect(self.body.error.code).toBe('maker_checker_violation');
    expect((await appr('post', `/payroll/runs/${run}/approve`)).body.data.status).toBe('approved');
    expect((await appr('post', `/payroll/runs/${run}/finalize`)).status).toBe(200);
  });
  it('waivers are recorded and survive re-validation', async () => {
    await w.admin.query(`UPDATE employees SET joined_at='2020-01-01', pay_group_id=$2, payroll_eligible=true WHERE id=$1`, [e3, ids.fp]);
    const per = (await fin('post', '/payroll/periods/generate', { payGroupId: ids.fp, month: '2026-08' })).body.data.id;
    await w.admin.query(`UPDATE employee_salary_assignments SET superseded_at=now() WHERE employee_id=$1`, [e3]);
    const run = (await fin('post', '/payroll/runs', { payrollPeriodId: per })).body.data.id;
    const v = await fin('post', `/payroll/runs/${run}/validate`);
    expect(v.body.data.run.status).toBe('draft');
    const x = v.body.data.exceptions.find((e: { code: string }) => e.code === 'NO_SALARY_ASSIGNMENT');
    expect((await fin('patch', `/payroll/exceptions/${x.id}`, { status: 'waived', note: 'x' })).status).toBe(422);
    expect((await call('patch', 'pf-hr', P, `/payroll/exceptions/${x.id}`, { status: 'waived', note: 'not allowed here' })).status).toBe(403);
    expect((await fin('patch', `/payroll/exceptions/${x.id}`, { status: 'waived', note: 'Contractor paid outside payroll' })).body.data.status).toBe('waived');
    expect((await fin('patch', `/payroll/exceptions/${x.id}`, { status: 'resolved', note: 'second try here' })).status).toBe(409);
    const again = await fin('post', `/payroll/runs/${run}/validate`);
    expect(again.body.data.run.status).toBe('validated');
    const calc = await fin('post', `/payroll/runs/${run}/calculate`);
    expect(calc.body.data.employeeCount).toBe(0);
    expect((await fin('get', `/payroll/runs/${run}/items`)).body.data[0].status).toBe('excluded');
    expect((await fin('post', `/payroll/runs/${run}/cancel`)).body.data.status).toBe('cancelled');
    expect((await fin('post', `/payroll/runs/${run}/cancel`)).status).toBe(409);
  });
});

describe('isolation', () => {
  it('another company sees nothing of this payroll', async () => {
    const q = (m: 'get' | 'post', p: string, b?: object) => call(m, 'pfq-fin', Q, p, b);
    expect((await q('get', '/payroll/runs')).body.data).toEqual([]);
    expect((await q('get', `/payroll/runs/${ids.run}`)).status).toBe(404);
    expect((await q('get', `/payroll/runs/${ids.run}/register`)).status).toBe(404);
    expect((await q('get', `/payroll/payslips/${ids.adj}`)).status).toBe(404);
    expect((await q('post', '/payroll/runs', { payrollPeriodId: ids.p })).status).toBe(404);
    expect((await q('get', '/payroll/pay-groups')).body.data).toEqual([]);
    expect((await q('get', '/payroll/adjustments')).body.data).toEqual([]);
    const cross = await w.h.http().get(`/payroll/runs/${ids.run}`).set(await w.as('pf-fin', Q, { mfa: true }));
    expect(cross.status).toBe(404);
  });
});
