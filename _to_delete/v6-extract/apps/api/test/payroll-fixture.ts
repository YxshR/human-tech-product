import { World, Tenant } from './fixtures';

export interface FinalRun { tenant: Tenant; runId: string; periodId: string; employees: { e1: string; e2: string }; subs: { fin: string; appr: string; e1: string; e2: string } }

/**
 * A complete, finalised September 2026 payroll run for two employees (28 and 26 paid days), driven
 * through the real API so downstream tests (payslips, downloads, worker jobs) start from the true state.
 */
export async function seedFinalizedRun(w: World, prefix: string): Promise<FinalRun> {
  const T = await w.tenant(prefix, `${prefix}-root`);
  const boot = `${prefix}-root-boot`;
  const subs = { fin: `${prefix}-fin`, appr: `${prefix}-appr`, e1: `${prefix}-e1`, e2: `${prefix}-e2` };
  await w.member(T, boot, subs.fin, ['finance_payroll']);
  await w.member(T, boot, subs.appr, ['payroll_approver']);
  await w.member(T, boot, subs.e1, ['employee'], [T.branch]);
  await w.member(T, boot, subs.e2, ['employee'], [T.branch]);
  const e1 = await w.employee(T, boot, subs.e1, { joined: '2020-01-01', name: 'Asha' });
  const e2 = await w.employee(T, boot, subs.e2, { joined: '2020-01-01', name: 'Bala' });
  type M = 'get' | 'post' | 'put';
  const call = async (m: M, sub: string, path: string, body?: object) => { const r = await w.h.http()[m](path).set(await w.as(sub, T, { mfa: true })).send(body); if (r.status >= 300) throw new Error(`${m} ${path} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body.data; };
  const fin = (m: M, p: string, b?: object) => call(m, subs.fin, p, b);
  const appr = (m: M, p: string, b?: object) => call(m, subs.appr, p, b);

  await w.system.query(
    `INSERT INTO statutory_rule_sets (rule_group, version, effective_from, definition, source_url, status, prepared_by, reviewed_by, reviewed_at)
     SELECT 'pf', 1, '2020-01-01', $1, 'https://example.test/pf-rule', 'approved', $2, $3, now() WHERE NOT EXISTS (SELECT 1 FROM statutory_rule_sets WHERE rule_group='pf' AND version=1)`,
    [JSON.stringify({ kind: 'percentage', rate: '0.12', baseCodes: ['BASIC'], baseCeiling: '15000' }), w.users[subs.fin], w.users[subs.appr]]);
  await w.system.query('UPDATE tenants SET payroll_activated_at=now() WHERE id=$1', [T.id]);

  const group = (await fin('post', '/payroll/pay-groups', { code: 'mth', name: 'Monthly staff' })).id;
  for (const e of [e1, e2]) await fin('put', `/payroll/employees/${e}/pay-setup`, { payGroupId: group, payrollEligible: true });
  const periodId = (await fin('post', '/payroll/periods/generate', { payGroupId: group, month: '2026-09' })).id;

  const mk = async (code: string, type: string, version: object) => {
    const c = await fin('post', '/compensation/components', { code, label: code, componentType: type });
    const v = await fin('post', `/compensation/components/${c.id}/versions`, { effectiveFrom: '2020-01-01', ...version });
    await fin('post', `/compensation/component-versions/${v.id}/activate`);
    return v.id as string;
  };
  const basic = await mk('BASIC', 'earning', { calculationMethod: 'fixed', defaultAmount: '20000' });
  const hra = await mk('HRA', 'earning', { calculationMethod: 'percentage_of_component', baseComponentCodes: ['BASIC'], defaultPercentage: '40' });
  const spl = await mk('SPECIAL', 'earning', { calculationMethod: 'fixed', configuration: { balance: true } });
  const pf = await mk('PF_EE', 'employee_deduction', { calculationMethod: 'statutory', statutoryGroup: 'pf', prorateOnUnpaidDays: false });
  const st = await fin('post', '/compensation/structures', { code: 'STD', name: 'Standard', effectiveFrom: '2020-01-01', components: [
    { componentVersionId: basic, displayOrder: 1 }, { componentVersionId: hra, displayOrder: 2 }, { componentVersionId: spl, displayOrder: 3 }, { componentVersionId: pf, displayOrder: 10 }] });
  await fin('post', `/compensation/structures/${st.id}/activate`);
  for (const emp of [e1, e2]) {
    const a = await fin('post', '/compensation/assignments', { employeeId: emp, salaryStructureId: st.id, effectiveFrom: '2020-01-01', monthlyCtc: '50000', changeReason: 'Initial salary' });
    await appr('post', `/compensation/assignments/${a.id}/approve`, {});
  }
  const rows: string[] = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    rows.push(`('${T.id}','${e1}','${date}','present',1)`);
    rows.push(`('${T.id}','${e2}','${date}','${d > 26 ? 'absent' : 'present'}',${d > 26 ? 0 : 1})`);
  }
  await w.admin.query(`INSERT INTO attendance_days (tenant_id, employee_id, work_date, attendance_status, paid_day_fraction) VALUES ${rows.join(',')}`);
  await fin('post', '/attendance/lock', { periodId });

  const runId = (await fin('post', '/payroll/runs', { payrollPeriodId: periodId })).id;
  await fin('post', `/payroll/runs/${runId}/validate`);
  await fin('post', `/payroll/runs/${runId}/calculate`);
  await fin('post', `/payroll/runs/${runId}/submit`);
  await appr('post', `/payroll/runs/${runId}/approve`);
  await appr('post', `/payroll/runs/${runId}/finalize`);
  return { tenant: T, runId, periodId, employees: { e1, e2 }, subs };
}
