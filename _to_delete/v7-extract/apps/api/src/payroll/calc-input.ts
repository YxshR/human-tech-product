import type { PoolClient } from 'pg';
import { ComponentDef, D, EmployeeInput, Rule } from '@humantech/payroll-engine';
import { lateDeductionDays } from '../attendance/derive';

export interface PeriodRow { id: string; payGroupId: string; code: string; start: string; end: string; attendanceLockedAt: Date | null; status: string }
export interface PayGroupRow { id: string; attendanceSource: 'attendance' | 'full_pay' }
export interface EligibleEmployee {
  id: string; number: string; name: string; branchId: string | null; stateCode: string | null; from: string; to: string;
}
export interface ExceptionDraft { code: string; severity: 'blocking' | 'warning'; message: string; employeeId?: string; details?: Record<string, string> }

const dayCount = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

/** Everyone the pay group pays for this period, with the window of days they are employed in it. */
export async function eligibleEmployees(c: PoolClient, tenantId: string, p: PeriodRow): Promise<EligibleEmployee[]> {
  const rows = (await c.query(
    `SELECT e.id, e.employee_number, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name, e.branch_id, b.state_code,
            to_char(GREATEST(e.joined_at, $3::date),'YYYY-MM-DD') AS d_from,
            to_char(LEAST($4::date, COALESCE(e.last_working_date, e.exited_at, $4::date)),'YYYY-MM-DD') AS d_to
       FROM employees e LEFT JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id
      WHERE e.tenant_id=$1 AND e.pay_group_id=$2 AND e.payroll_eligible AND e.employment_status NOT IN ('archived','onboarding')
        AND e.joined_at <= $4::date AND COALESCE(e.last_working_date, e.exited_at, $4::date) >= $3::date
      ORDER BY e.employee_number`, [tenantId, p.payGroupId, p.start, p.end])).rows;
  return rows.map((r) => ({ id: r.id, number: r.employee_number, name: r.name, branchId: r.branch_id, stateCode: r.state_code, from: r.d_from, to: r.d_to }));
}

interface AssignmentRow { id: string; employeeId: string; structureId: string; monthlyCtc: string }
export async function currentAssignments(c: PoolClient, tenantId: string, p: PeriodRow, employeeIds: string[]): Promise<Map<string, AssignmentRow>> {
  if (!employeeIds.length) return new Map();
  const rows = (await c.query(
    `SELECT DISTINCT ON (employee_id) id, employee_id, salary_structure_id, monthly_ctc::text
       FROM employee_salary_assignments
      WHERE tenant_id=$1 AND employee_id = ANY($2::uuid[]) AND approval_status='approved' AND superseded_at IS NULL
        AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY employee_id, effective_from DESC`, [tenantId, employeeIds, p.start, p.end])).rows;
  return new Map(rows.map((r) => [r.employee_id as string, { id: r.id, employeeId: r.employee_id, structureId: r.salary_structure_id, monthlyCtc: r.monthly_ctc }]));
}

export interface DayCounts { workingDays: string; paidDays: string }
/** Paid days per employee, from locked attendance or "full pay except approved unpaid leave". */
export async function paidDaysFor(c: PoolClient, tenantId: string, p: PeriodRow, g: PayGroupRow, emps: EligibleEmployee[]): Promise<Map<string, DayCounts>> {
  const working = dayCount(p.start, p.end);
  const out = new Map<string, DayCounts>();
  if (!emps.length) return out;
  const agg = new Map<string, { paid: number; unpaidLeave: number; late: number }>();
  const rows = (await c.query(
    `SELECT d.employee_id, COALESCE(sum(d.paid_day_fraction),0)::float8 AS paid,
            COALESCE(sum(1 - d.paid_day_fraction) FILTER (WHERE d.attendance_status = 'leave'),0)::float8 AS unpaid_leave,
            count(*) FILTER (WHERE d.late_minutes > 0)::int AS late
       FROM attendance_days d JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id
      WHERE d.tenant_id=$1 AND d.employee_id = ANY($2::uuid[]) AND d.approval_status='approved'
        AND d.work_date BETWEEN $3::date AND $4::date AND d.work_date BETWEEN GREATEST(e.joined_at,$3::date) AND $4::date
      GROUP BY d.employee_id`, [tenantId, emps.map((e) => e.id), p.start, p.end])).rows;
  for (const r of rows) agg.set(r.employee_id, { paid: r.paid, unpaidLeave: r.unpaid_leave, late: r.late });
  const marks = (await c.query<{ m: number | null }>(
    `SELECT late_marks_per_half_day AS m FROM attendance_policies WHERE tenant_id=$1 AND status='active' AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date) ORDER BY version DESC LIMIT 1`, [tenantId, p.start])).rows[0]?.m ?? null;
  for (const e of emps) {
    const window = dayCount(e.from, e.to);
    const a = agg.get(e.id) ?? { paid: 0, unpaidLeave: 0, late: 0 };
    let paid: number;
    if (g.attendanceSource === 'full_pay') paid = window - a.unpaidLeave;
    else paid = a.paid - lateDeductionDays(a.late, marks);
    paid = Math.min(Math.max(0, paid), window);
    out.set(e.id, { workingDays: String(working), paidDays: (Math.round(paid * 100) / 100).toFixed(2) });
  }
  return out;
}

export interface ResolvedRules { rules: Map<string, Rule>; pick: (group: string, state: string | null) => Rule | undefined }
export async function approvedRules(c: PoolClient, p: PeriodRow): Promise<ResolvedRules> {
  const rows = (await c.query(
    `SELECT id, rule_group, state_code, version, definition FROM statutory_rule_sets
      WHERE jurisdiction='IN' AND status='approved' AND effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date)`, [p.end])).rows;
  const rules = new Map<string, Rule>();
  const byKey = new Map<string, Rule>();
  for (const r of rows) {
    const rule: Rule = { id: r.id, group: r.rule_group, version: r.version, def: r.definition };
    rules.set(rule.id, rule); byKey.set(`${r.rule_group}|${r.state_code ?? ''}`, rule);
  }
  return { rules, pick: (g, s) => (s ? byKey.get(`${g}|${s}`) : undefined) ?? byKey.get(`${g}|`) };
}

export interface StructureLine {
  structureId: string; componentVersionId: string; code: string; label: string; type: ComponentDef['type']; method: string;
  amount: string | null; percentage: string | null; displayOrder: number; baseCodes: string[]; defAmount: string | null; defPercentage: string | null;
  roundingMode: ComponentDef['rounding']['mode']; roundingPlaces: 0 | 1 | 2; prorate: boolean; statutoryGroup: string | null; config: { balance?: boolean; basis?: 'full' | 'earned'; stateScoped?: boolean };
}
export async function structureLines(c: PoolClient, tenantId: string, structureIds: string[]): Promise<Map<string, StructureLine[]>> {
  const out = new Map<string, StructureLine[]>();
  if (!structureIds.length) return out;
  const rows = (await c.query(
    `SELECT sc.salary_structure_id, sc.component_version_id, sc.amount::text, sc.percentage::text, sc.display_order, comp.code, comp.component_type, cv.label_snapshot,
            cv.calculation_method, cv.base_component_codes, cv.default_amount::text, cv.default_percentage::text, cv.rounding_mode, cv.rounding_places,
            cv.prorate_on_unpaid_days, cv.statutory_group, cv.configuration
       FROM salary_structure_components sc
       JOIN salary_component_versions cv ON cv.tenant_id=sc.tenant_id AND cv.id=sc.component_version_id
       JOIN salary_components comp ON comp.tenant_id=cv.tenant_id AND comp.id=cv.component_id
      WHERE sc.tenant_id=$1 AND sc.salary_structure_id = ANY($2::uuid[]) ORDER BY sc.display_order, comp.code`, [tenantId, structureIds])).rows;
  for (const r of rows) {
    const l: StructureLine = {
      structureId: r.salary_structure_id, componentVersionId: r.component_version_id, code: r.code, label: r.label_snapshot, type: r.component_type, method: r.calculation_method,
      amount: r.amount, percentage: r.percentage, displayOrder: r.display_order, baseCodes: r.base_component_codes, defAmount: r.default_amount, defPercentage: r.default_percentage,
      roundingMode: r.rounding_mode, roundingPlaces: r.rounding_places, prorate: r.prorate_on_unpaid_days, statutoryGroup: r.statutory_group, config: r.configuration ?? {},
    };
    const arr = out.get(l.structureId) ?? []; arr.push(l); out.set(l.structureId, arr);
  }
  return out;
}

export async function overridesFor(c: PoolClient, tenantId: string, assignmentIds: string[]): Promise<Map<string, Map<string, { amount: string | null; percentage: string | null }>>> {
  const out = new Map<string, Map<string, { amount: string | null; percentage: string | null }>>();
  if (!assignmentIds.length) return out;
  const rows = (await c.query('SELECT assignment_id, component_version_id, amount::text, percentage::text FROM employee_salary_overrides WHERE tenant_id=$1 AND assignment_id = ANY($2::uuid[])', [tenantId, assignmentIds])).rows;
  for (const r of rows) {
    const m = out.get(r.assignment_id) ?? new Map(); m.set(r.component_version_id, { amount: r.amount, percentage: r.percentage }); out.set(r.assignment_id, m);
  }
  return out;
}

/** Turns one employee's structure lines into engine components; problems become exception drafts instead of silent zeros. */
export function buildComponents(
  emp: EligibleEmployee, lines: StructureLine[], ov: Map<string, { amount: string | null; percentage: string | null }> | undefined,
  monthlyCtc: string, paidDays: string, rules: ResolvedRules, problems: ExceptionDraft[],
): { components: ComponentDef[]; ruleIds: string[] } {
  const components: ComponentDef[] = []; const ruleIds: string[] = [];
  const problem = (code: string, message: string, details: Record<string, string>) => problems.push({ code, severity: 'blocking', message, employeeId: emp.id, details });
  for (const l of lines) {
    const o = ov?.get(l.componentVersionId);
    const base = { code: l.code, label: l.label, type: l.type, rounding: { mode: l.roundingMode, places: l.roundingPlaces }, displayOrder: l.displayOrder, versionId: l.componentVersionId };
    const amount = o?.amount ?? l.amount ?? l.defAmount;
    switch (l.method) {
      case 'fixed':
        if (l.config.balance) { components.push({ ...base, method: { kind: 'balance', target: monthlyCtc }, prorate: l.prorate }); break; }
        if (amount == null) { problem('COMPONENT_AMOUNT_MISSING', `${l.code} has no amount`, { component: l.code }); break; }
        components.push({ ...base, method: { kind: 'fixed', amount }, prorate: l.prorate });
        break;
      case 'percentage_of_component': {
        const pct = o?.percentage ?? l.percentage ?? l.defPercentage;
        if (pct == null) { problem('COMPONENT_PERCENTAGE_MISSING', `${l.code} has no percentage`, { component: l.code }); break; }
        components.push({ ...base, method: { kind: 'percent_of', percentage: pct, baseCodes: l.baseCodes, basis: l.config.basis ?? 'full' }, prorate: l.prorate });
        break;
      }
      case 'per_day': {
        if (amount == null) { problem('COMPONENT_AMOUNT_MISSING', `${l.code} has no per-day rate`, { component: l.code }); break; }
        components.push({ ...base, method: { kind: 'fixed', amount: D(amount).times(D(paidDays)).toFixed(4) }, prorate: false });
        break;
      }
      case 'statutory': {
        const rule = l.statutoryGroup ? rules.pick(l.statutoryGroup, l.config.stateScoped === false ? null : emp.stateCode) : undefined;
        if (!rule) { problem('NO_APPROVED_RULE', `No approved ${l.statutoryGroup} rule set applies to ${l.code} for this period${emp.stateCode ? ` (state ${emp.stateCode})` : ''}`, { component: l.code, group: l.statutoryGroup ?? '' }); break; }
        components.push({ ...base, method: { kind: 'rule', ruleId: rule.id }, prorate: false }); ruleIds.push(rule.id);
        break;
      }
      default:
        problem('UNSUPPORTED_METHOD', `${l.code} uses an unsupported calculation method (${l.method})`, { component: l.code, method: l.method });
    }
  }
  return { components, ruleIds };
}

export type { EmployeeInput };
