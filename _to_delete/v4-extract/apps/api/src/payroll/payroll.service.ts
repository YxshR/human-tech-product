import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { authorizeOnEmployee } from '@humantech/authz';
import {
  AdjustmentView, ExceptionView, LineView, PayGroupView, PayslipView, PeriodView, RunItemView, RunView, correctRun, createAdjustment, createPayGroup, createRun, decodeCursor,
  encodeCursor, generatePeriod, itemsQuery, paySetup, rejectRun, resolveException, reviewAdjustment, updatePayGroup,
} from '@humantech/contracts';
import { ENGINE_VERSION, EmployeeInput, calculateRun } from '@humantech/payroll-engine';
import { PostgresJobProducer } from '@humantech/jobs';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { csvCell } from '../common/csv';
import { DocumentsService } from '../files/documents.service';
import { ApiError, forbidden, notFound } from '../common/errors';
import {
  ExceptionDraft, PayGroupRow, PeriodRow, approvedRules, buildComponents, currentAssignments, eligibleEmployees, overridesFor, paidDaysFor, structureLines,
} from './calc-input';

const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const RUN_SELECT = `SELECT r.id, r.payroll_period_id, p.period_code, r.revision, r.run_kind, r.status, r.payment_status, r.engine_version,
    r.total_gross::text, r.total_employee_deductions::text, r.total_employer_contributions::text, r.total_net_pay::text,
    (SELECT count(*)::int FROM payroll_run_items i WHERE i.tenant_id=r.tenant_id AND i.payroll_run_id=r.id AND i.status<>'excluded') AS employee_count,
    (SELECT count(*)::int FROM payroll_exceptions x WHERE x.tenant_id=r.tenant_id AND x.payroll_run_id=r.id AND x.status='open' AND x.severity='blocking') AS open_blocking,
    (SELECT count(*)::int FROM payroll_exceptions x WHERE x.tenant_id=r.tenant_id AND x.payroll_run_id=r.id AND x.status='open' AND x.severity='warning') AS open_warnings,
    r.correction_of_run_id, r.correction_reason, r.rejection_reason, r.created_by, r.submitted_by, r.approved_by, r.locked_by,
    r.created_at, r.submitted_at, r.approved_at, r.locked_at
  FROM payroll_runs r JOIN payroll_periods p ON p.tenant_id=r.tenant_id AND p.id=r.payroll_period_id`;
const runView = (r: Record<string, unknown>): RunView => ({
  id: r.id as string, payrollPeriodId: r.payroll_period_id as string, periodCode: r.period_code as string, revision: r.revision as number, runKind: r.run_kind as string,
  status: r.status as string, paymentStatus: r.payment_status as string, engineVersion: (r.engine_version as string | null) ?? null,
  totals: r.total_gross == null ? null : { gross: r.total_gross as string, employeeDeductions: r.total_employee_deductions as string, employerContributions: r.total_employer_contributions as string, netPay: r.total_net_pay as string },
  employeeCount: r.employee_count as number, openBlocking: r.open_blocking as number, openWarnings: r.open_warnings as number,
  correctionOfRunId: (r.correction_of_run_id as string | null) ?? null, correctionReason: (r.correction_reason as string | null) ?? null, rejectionReason: (r.rejection_reason as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null, submittedBy: (r.submitted_by as string | null) ?? null, approvedBy: (r.approved_by as string | null) ?? null, lockedBy: (r.locked_by as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(), submittedAt: iso(r.submitted_at as Date | null), approvedAt: iso(r.approved_at as Date | null), lockedAt: iso(r.locked_at as Date | null),
});
const PERIOD_SELECT = `SELECT id, pay_group_id, period_code, to_char(period_start,'YYYY-MM-DD') AS period_start, to_char(period_end,'YYYY-MM-DD') AS period_end, attendance_locked_at, status FROM payroll_periods`;
const periodView = (r: Record<string, unknown>): PeriodView => ({
  id: r.id as string, payGroupId: r.pay_group_id as string, periodCode: r.period_code as string, periodStart: r.period_start as string, periodEnd: r.period_end as string,
  attendanceLockedAt: iso(r.attendance_locked_at as Date | null), status: r.status as string,
});
const groupView = (r: Record<string, unknown>): PayGroupView => ({
  id: r.id as string, code: r.code as string, name: r.name as string, frequency: r.frequency as string, periodStartDay: r.period_start_day as number,
  attendanceSource: r.attendance_source as string, inputCutoffDay: (r.input_cutoff_day as number | null) ?? null, payDay: (r.pay_day as number | null) ?? null, status: r.status as string,
});
const GROUP_COLS = 'id, code, name, frequency, period_start_day, attendance_source, input_cutoff_day, pay_day, status';

type RunRow = { id: string; status: string; payroll_period_id: string; created_by: string | null; submitted_by: string | null; revision: number; run_kind: string };

@Injectable()
export class PayrollService {
  private readonly producer = new PostgresJobProducer();
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService, @Inject(DocumentsService) private readonly files: DocumentsService) {}

  // ---- scope helpers -------------------------------------------------------------------------------------------------
  private scopeSql(a: RequestAuth, alias: string, params: unknown[]): string {
    if (a.branchScope.mode !== 'listed') return '';
    params.push([...a.branchScope.branchIds]);
    return ` AND ${alias}.branch_id = ANY($${params.length}::uuid[])`;
  }

  // ---- status & activation ----------------------------------------------------------------------------------------
  async status(a: RequestAuth): Promise<{ activated: boolean; activatedAt: string | null; activationRequestedAt: string | null; makerCheckerRequired: boolean }> {
    return this.db.run(ctxOf(a), async (c) => {
      const t = (await c.query('SELECT payroll_activated_at, payroll_activation_requested_at, payroll_maker_checker_required FROM tenants WHERE id=$1', [a.tenantId])).rows[0];
      if (!t) throw notFound('company');
      return { activated: !!t.payroll_activated_at, activatedAt: iso(t.payroll_activated_at), activationRequestedAt: iso(t.payroll_activation_requested_at), makerCheckerRequired: t.payroll_maker_checker_required };
    });
  }
  async requestActivation(a: RequestAuth): Promise<{ activationRequestedAt: string }> {
    return this.db.run(ctxOf(a, 'payroll activation requested'), async (c) => {
      const t = (await c.query('SELECT payroll_activated_at, payroll_activation_requested_at FROM tenants WHERE id=$1 FOR UPDATE', [a.tenantId])).rows[0];
      if (!t) throw notFound('company');
      if (t.payroll_activated_at) throw new ApiError('conflict', 409, 'Payroll is already activated for this company');
      if (t.payroll_activation_requested_at) return { activationRequestedAt: t.payroll_activation_requested_at.toISOString() };
      const r = (await c.query<{ at: Date }>('UPDATE tenants SET payroll_activation_requested_at=now() WHERE id=$1 RETURNING payroll_activation_requested_at AS at', [a.tenantId])).rows[0]!;
      await this.producer.enqueue(c, {
        tenantId: a.tenantId, type: 'payroll.activation_requested', aggregateType: 'tenants', aggregateId: a.tenantId, idempotencyKey: `payroll-activation-requested:${a.tenantId}`,
        payload: { requestedBy: a.userId }, correlationId: a.requestId,
      });
      await this.audit.record(c, a, 'payroll.activation_request', 'tenants', a.tenantId, null, { requestedAt: r.at.toISOString() });
      return { activationRequestedAt: r.at.toISOString() };
    });
  }

  // ---- pay groups & setup --------------------------------------------------------------------------------------------
  async listGroups(a: RequestAuth): Promise<PayGroupView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(`SELECT ${GROUP_COLS} FROM pay_groups WHERE tenant_id=$1 ORDER BY code`, [a.tenantId])).rows.map(groupView));
  }
  async createGroup(a: RequestAuth, body: unknown): Promise<PayGroupView> {
    const b = createPayGroup.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(
        `INSERT INTO pay_groups (tenant_id, code, name, frequency, period_start_day, attendance_source, input_cutoff_day, pay_day) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${GROUP_COLS}`,
        [a.tenantId, b.code, b.name, b.frequency, b.periodStartDay, b.attendanceSource, b.inputCutoffDay ?? null, b.payDay ?? null])).rows[0]!;
      await this.audit.record(c, a, 'pay_group.create', 'pay_groups', r.id, null, { code: b.code });
      return groupView(r);
    });
  }
  async updateGroup(a: RequestAuth, id: string, body: unknown): Promise<PayGroupView> {
    const b = updatePayGroup.parse(body);
    if (!Object.keys(b).length) throw new ApiError('validation_failed', 422, 'Nothing to update');
    return this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query(`SELECT ${GROUP_COLS} FROM pay_groups WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('pay group');
      if (b.status && b.status !== 'active') {
        const inUse = await c.query(`SELECT 1 FROM payroll_runs r JOIN payroll_periods p ON p.tenant_id=r.tenant_id AND p.id=r.payroll_period_id
          WHERE p.tenant_id=$1 AND p.pay_group_id=$2 AND r.status NOT IN ('locked','payslips_generated','cancelled') LIMIT 1`, [a.tenantId, id]);
        if (inUse.rowCount) throw new ApiError('conflict', 409, 'This pay group has a payroll run in progress');
      }
      const r = (await c.query(
        `UPDATE pay_groups SET name=COALESCE($3,name), attendance_source=COALESCE($4,attendance_source), status=COALESCE($7,status),
            input_cutoff_day=CASE WHEN $5::boolean THEN $8::smallint ELSE input_cutoff_day END, pay_day=CASE WHEN $6::boolean THEN $9::smallint ELSE pay_day END
          WHERE tenant_id=$1 AND id=$2 RETURNING ${GROUP_COLS}`,
        [a.tenantId, id, b.name ?? null, b.attendanceSource ?? null, b.inputCutoffDay !== undefined, b.payDay !== undefined, b.status ?? null, b.inputCutoffDay ?? null, b.payDay ?? null])).rows[0]!;
      await this.audit.record(c, a, 'pay_group.update', 'pay_groups', id, groupView(cur), groupView(r));
      return groupView(r);
    });
  }
  async setEmployeePaySetup(a: RequestAuth, employeeId: string, body: unknown): Promise<{ employeeId: string; payGroupId: string | null; payrollEligible: boolean }> {
    const b = paySetup.parse(body);
    return this.db.run(ctxOf(a, 'employee pay setup'), async (c) => {
      const e = (await c.query<{ branch_id: string | null; joined_at: string | null; pay_group_id: string | null; payroll_eligible: boolean }>(
        'SELECT branch_id, joined_at, pay_group_id, payroll_eligible FROM employees WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, employeeId])).rows[0];
      if (!e) throw notFound('employee');
      const d = authorizeOnEmployee(a, 'payroll.manage_settings', { tenantId: a.tenantId, branchId: e.branch_id, employeeId });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
      if (b.payrollEligible && !b.payGroupId) throw new ApiError('validation_failed', 422, 'A pay group is required for payroll-eligible employees', [{ path: 'payGroupId', message: 'required' }]);
      if (b.payrollEligible && !e.joined_at) throw new ApiError('validation_failed', 422, 'Set the joining date before making the employee payroll-eligible', [{ path: 'payrollEligible', message: 'joining date missing' }]);
      if (b.payGroupId) {
        const g = await c.query(`SELECT 1 FROM pay_groups WHERE tenant_id=$1 AND id=$2 AND status='active'`, [a.tenantId, b.payGroupId]);
        if (!g.rowCount) throw new ApiError('validation_failed', 422, 'Unknown or inactive pay group', [{ path: 'payGroupId', message: 'not found' }]);
      }
      await c.query('UPDATE employees SET pay_group_id=$3, payroll_eligible=$4 WHERE tenant_id=$1 AND id=$2', [a.tenantId, employeeId, b.payGroupId, b.payrollEligible]);
      await this.audit.record(c, a, 'employee.pay_setup', 'employees', employeeId, { payGroupId: e.pay_group_id, payrollEligible: e.payroll_eligible }, { payGroupId: b.payGroupId, payrollEligible: b.payrollEligible });
      return { employeeId, payGroupId: b.payGroupId, payrollEligible: b.payrollEligible };
    });
  }

  // ---- periods ----------------------------------------------------------------------------------------------------
  async listPeriods(a: RequestAuth, payGroupId?: string): Promise<PeriodView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(`${PERIOD_SELECT} WHERE tenant_id=$1 AND ($2::uuid IS NULL OR pay_group_id=$2) ORDER BY period_start DESC LIMIT 120`, [a.tenantId, payGroupId ?? null])).rows.map(periodView));
  }
  async generatePeriod(a: RequestAuth, body: unknown): Promise<PeriodView> {
    const b = generatePeriod.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const g = (await c.query<{ period_start_day: number; status: string }>('SELECT period_start_day, status FROM pay_groups WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.payGroupId])).rows[0];
      if (!g) throw notFound('pay group');
      if (g.status !== 'active') throw new ApiError('invalid_state', 409, 'The pay group is not active');
      const start = `${b.month}-${String(g.period_start_day).padStart(2, '0')}`;
      const r = (await c.query(
        `INSERT INTO payroll_periods (tenant_id, pay_group_id, period_code, period_start, period_end, created_by)
         VALUES ($1,$2,$3,$4::date,($4::date + interval '1 month' - interval '1 day')::date,$5)
         RETURNING id, pay_group_id, period_code, to_char(period_start,'YYYY-MM-DD') AS period_start, to_char(period_end,'YYYY-MM-DD') AS period_end, attendance_locked_at, status`,
        [a.tenantId, b.payGroupId, b.month, start, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'payroll_period.create', 'payroll_periods', r.id, null, { periodCode: b.month });
      return periodView(r);
    });
  }

  // ---- runs: reads -------------------------------------------------------------------------------------------------
  async listRuns(a: RequestAuth, periodId?: string): Promise<RunView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(`${RUN_SELECT} WHERE r.tenant_id=$1 AND ($2::uuid IS NULL OR r.payroll_period_id=$2) ORDER BY p.period_start DESC, r.revision DESC LIMIT 100`, [a.tenantId, periodId ?? null])).rows.map(runView));
  }
  private async loadRunView(c: PoolClient, a: RequestAuth, id: string): Promise<RunView> {
    const r = (await c.query(`${RUN_SELECT} WHERE r.tenant_id=$1 AND r.id=$2`, [a.tenantId, id])).rows[0];
    if (!r) throw notFound('payroll run');
    return runView(r);
  }
  async getRun(a: RequestAuth, id: string): Promise<RunView> { return this.db.run(ctxOf(a), (c) => this.loadRunView(c, a, id)); }

  async listExceptions(a: RequestAuth, runId: string): Promise<ExceptionView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      await this.loadRunView(c, a, runId);
      const rows = (await c.query(
        `SELECT x.id, x.stage, x.severity, x.code, x.message, x.employee_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name, x.status, x.resolution_note, x.details
           FROM payroll_exceptions x LEFT JOIN employees e ON e.tenant_id=x.tenant_id AND e.id=x.employee_id
          WHERE x.tenant_id=$1 AND x.payroll_run_id=$2 ORDER BY (x.status='open') DESC, x.severity, x.created_at, x.id`, [a.tenantId, runId])).rows;
      return rows.map((x) => ({ id: x.id, stage: x.stage, severity: x.severity, code: x.code, message: x.message, employeeId: x.employee_id, employeeName: x.employee_name, status: x.status, resolutionNote: x.resolution_note, details: x.details }));
    });
  }

  async listItems(a: RequestAuth, runId: string, query: unknown): Promise<{ data: RunItemView[]; nextCursor: string | null }> {
    const q = itemsQuery.parse(query);
    return this.db.run(ctxOf(a), async (c) => {
      await this.loadRunView(c, a, runId);
      const params: unknown[] = [a.tenantId, runId];
      let where = this.scopeSql(a, 'e', params);
      if (q.status) { params.push(q.status); where += ` AND i.status=$${params.length}`; }
      if (q.cursor) {
        let k: Array<string | number>;
        try { k = decodeCursor(q.cursor); } catch { throw new ApiError('validation_failed', 422, 'Invalid cursor', [{ path: 'cursor', message: 'invalid cursor' }]); }
        if (typeof k[0] !== 'string') throw new ApiError('validation_failed', 422, 'Invalid cursor', [{ path: 'cursor', message: 'invalid cursor' }]);
        params.push(k[0]); where += ` AND e.employee_number > $${params.length}`;
      }
      params.push(q.limit + 1);
      const rows = (await c.query(
        `SELECT i.id, i.employee_id, e.employee_number, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name, i.working_days::text, i.paid_days::text, i.unpaid_days::text,
                i.gross_earnings::text, i.employee_deductions::text, i.employer_contributions::text, i.net_pay::text, i.status, i.warnings
           FROM payroll_run_items i JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id
          WHERE i.tenant_id=$1 AND i.payroll_run_id=$2 ${where} ORDER BY e.employee_number LIMIT $${params.length}`, params)).rows;
      const page = rows.slice(0, q.limit);
      return {
        data: page.map((r) => ({ id: r.id, employeeId: r.employee_id, employeeNumber: r.employee_number, employeeName: r.employee_name, workingDays: r.working_days ?? '0', paidDays: r.paid_days ?? '0', unpaidDays: r.unpaid_days ?? '0',
          grossEarnings: r.gross_earnings, employeeDeductions: r.employee_deductions, employerContributions: r.employer_contributions, netPay: r.net_pay, status: r.status, warnings: r.warnings })),
        nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.employee_number]) : null,
      };
    });
  }
  async itemLines(a: RequestAuth, runId: string, itemId: string): Promise<{ item: RunItemView; lines: LineView[] }> {
    const page = await this.db.run(ctxOf(a), async (c) => {
      await this.loadRunView(c, a, runId);
      const params: unknown[] = [a.tenantId, runId, itemId];
      const scope = this.scopeSql(a, 'e', params);
      const it = (await c.query(
        `SELECT i.id, i.employee_id, e.employee_number, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name, i.working_days::text, i.paid_days::text, i.unpaid_days::text,
                i.gross_earnings::text, i.employee_deductions::text, i.employer_contributions::text, i.net_pay::text, i.status, i.warnings
           FROM payroll_run_items i JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id WHERE i.tenant_id=$1 AND i.payroll_run_id=$2 AND i.id=$3 ${scope}`, params)).rows[0];
      if (!it) throw notFound('payroll item');
      const lines = (await c.query(
        `SELECT component_code, component_label_snapshot, component_type, calculation_method, amount::text, calculation_base::text, applied_rate::text, trace
           FROM payroll_line_items WHERE tenant_id=$1 AND payroll_run_item_id=$2 ORDER BY display_order, component_code`, [a.tenantId, itemId])).rows;
      return { it, lines };
    });
    const r = page.it;
    return {
      item: { id: r.id, employeeId: r.employee_id, employeeNumber: r.employee_number, employeeName: r.employee_name, workingDays: r.working_days ?? '0', paidDays: r.paid_days ?? '0', unpaidDays: r.unpaid_days ?? '0',
        grossEarnings: r.gross_earnings, employeeDeductions: r.employee_deductions, employerContributions: r.employer_contributions, netPay: r.net_pay, status: r.status, warnings: r.warnings },
      lines: page.lines.map((l) => ({ componentCode: l.component_code, label: l.component_label_snapshot, type: l.component_type, method: l.calculation_method, amount: l.amount, calculationBase: l.calculation_base, appliedRate: l.applied_rate, trace: l.trace })),
    };
  }

  // ---- runs: workflow -----------------------------------------------------------------------------------------------
  private async lockRun(c: PoolClient, a: RequestAuth, id: string): Promise<RunRow> {
    const r = (await c.query<RunRow>('SELECT id, status, payroll_period_id, created_by, submitted_by, revision, run_kind FROM payroll_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
    if (!r) throw notFound('payroll run');
    return r;
  }
  private requireStatus(r: RunRow, allowed: string[], verb: string): void {
    if (!allowed.includes(r.status)) throw new ApiError('invalid_state', 409, `A run that is ${r.status} cannot be ${verb}`);
  }
  private async loadPeriod(c: PoolClient, a: RequestAuth, periodId: string): Promise<{ period: PeriodRow; group: PayGroupRow }> {
    const p = (await c.query(`SELECT p.id, p.pay_group_id, p.period_code, to_char(p.period_start,'YYYY-MM-DD') AS s, to_char(p.period_end,'YYYY-MM-DD') AS e, p.attendance_locked_at, p.status, g.attendance_source
      FROM payroll_periods p JOIN pay_groups g ON g.tenant_id=p.tenant_id AND g.id=p.pay_group_id WHERE p.tenant_id=$1 AND p.id=$2`, [a.tenantId, periodId])).rows[0];
    if (!p) throw notFound('payroll period');
    return { period: { id: p.id, payGroupId: p.pay_group_id, code: p.period_code, start: p.s, end: p.e, attendanceLockedAt: p.attendance_locked_at, status: p.status }, group: { id: p.pay_group_id, attendanceSource: p.attendance_source } };
  }

  async createRun(a: RequestAuth, body: unknown): Promise<RunView> {
    const b = createRun.parse(body);
    return this.db.run(ctxOf(a, 'payroll run created'), async (c) => {
      const { period } = await this.loadPeriod(c, a, b.payrollPeriodId);
      if (period.status === 'archived') throw new ApiError('invalid_state', 409, 'This period is archived');
      const done = await c.query(`SELECT revision FROM payroll_runs WHERE tenant_id=$1 AND payroll_period_id=$2 AND status IN ('locked','payslips_generated') LIMIT 1`, [a.tenantId, b.payrollPeriodId]);
      if (done.rowCount) throw new ApiError('conflict', 409, 'This period already has a finalised run; start a correction instead');
      const r = (await c.query<{ id: string }>('INSERT INTO payroll_runs (tenant_id, payroll_period_id, created_by) VALUES ($1,$2,$3) RETURNING id', [a.tenantId, b.payrollPeriodId, a.userId])).rows[0]!;
      await c.query(`UPDATE payroll_periods SET status='processing' WHERE tenant_id=$1 AND id=$2 AND status='open'`, [a.tenantId, b.payrollPeriodId]);
      await this.audit.record(c, a, 'payroll_run.create', 'payroll_runs', r.id, null, { periodCode: period.code });
      return this.loadRunView(c, a, r.id);
    });
  }

  /** Re-runs the checks and keeps decisions already taken (resolved/waived) for the same code and employee. */
  async validate(a: RequestAuth, runId: string): Promise<{ run: RunView; exceptions: ExceptionView[] }> {
    const run = await this.db.run(ctxOf(a, 'payroll run validated'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['draft'], 'validated');
      const { period, group } = await this.loadPeriod(c, a, r.payroll_period_id);
      const emps = await eligibleEmployees(c, a.tenantId, period);
      const assigned = await currentAssignments(c, a.tenantId, period, emps.map((e) => e.id));
      const found: ExceptionDraft[] = [];
      if (!emps.length) found.push({ code: 'NO_ELIGIBLE_EMPLOYEES', severity: 'blocking', message: 'No payroll-eligible employees belong to this pay group for the period' });
      if (group.attendanceSource === 'attendance' && !period.attendanceLockedAt) found.push({ code: 'ATTENDANCE_NOT_LOCKED', severity: 'blocking', message: 'Attendance for this period has not been locked' });
      for (const e of emps) if (!assigned.has(e.id)) found.push({ code: 'NO_SALARY_ASSIGNMENT', severity: 'blocking', employeeId: e.id, message: `${e.name} (${e.number}) has no approved salary assignment for this period` });
      const pend = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM payroll_adjustments WHERE tenant_id=$1 AND payroll_period_id=$2 AND status='draft'`, [a.tenantId, period.id])).rows[0]!.n;
      if (pend) found.push({ code: 'UNAPPROVED_ADJUSTMENTS', severity: 'warning', message: `${pend} adjustment(s) are awaiting approval and will not be included` });
      const leave = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM leave_requests WHERE tenant_id=$1 AND status='pending' AND start_date <= $3::date AND end_date >= $2::date`, [a.tenantId, period.start, period.end])).rows[0]!.n;
      if (leave) found.push({ code: 'PENDING_LEAVE_REQUESTS', severity: 'warning', message: `${leave} leave request(s) overlapping the period are still pending` });

      const kept = (await c.query<{ code: string; employee_id: string | null }>(
        `SELECT code, employee_id FROM payroll_exceptions WHERE tenant_id=$1 AND payroll_run_id=$2 AND stage='validation' AND status<>'open'`, [a.tenantId, runId])).rows;
      const keptKeys = new Set(kept.map((k) => `${k.code}|${k.employee_id ?? ''}`));
      await c.query(`DELETE FROM payroll_exceptions WHERE tenant_id=$1 AND payroll_run_id=$2 AND stage='validation' AND status='open'`, [a.tenantId, runId]);
      for (const x of found) {
        if (keptKeys.has(`${x.code}|${x.employeeId ?? ''}`)) continue;
        await c.query(`INSERT INTO payroll_exceptions (tenant_id, payroll_run_id, employee_id, stage, severity, code, message, details) VALUES ($1,$2,$3,'validation',$4,$5,$6,$7)`,
          [a.tenantId, runId, x.employeeId ?? null, x.severity, x.code, x.message, JSON.stringify(x.details ?? {})]);
      }
      const open = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM payroll_exceptions WHERE tenant_id=$1 AND payroll_run_id=$2 AND stage='validation' AND severity='blocking' AND status='open'`, [a.tenantId, runId])).rows[0]!.n;
      if (open === 0) await c.query(`UPDATE payroll_runs SET status='validated' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, runId]);
      await this.audit.record(c, a, 'payroll_run.validate', 'payroll_runs', runId, null, { blocking: open, outcome: open === 0 ? 'validated' : 'blocked' });
      return this.loadRunView(c, a, runId);
    });
    return { run, exceptions: await this.listExceptions(a, runId) };
  }

  async calculate(a: RequestAuth, runId: string): Promise<RunView> {
    return this.db.run(ctxOf(a, 'payroll run calculated'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['validated'], 'calculated');
      const { period, group } = await this.loadPeriod(c, a, r.payroll_period_id);
      const emps = await eligibleEmployees(c, a.tenantId, period);
      const assigned = await currentAssignments(c, a.tenantId, period, emps.map((e) => e.id));
      const structures = await structureLines(c, a.tenantId, [...new Set([...assigned.values()].map((x) => x.structureId))]);
      const ovs = await overridesFor(c, a.tenantId, [...assigned.values()].map((x) => x.id));
      const days = await paidDaysFor(c, a.tenantId, period, group, emps);
      const rules = await approvedRules(c, period);
      const adjRows = (await c.query(
        `SELECT adj.id, adj.employee_id, adj.kind, adj.amount::text, adj.reason, adj.status, comp.code FROM payroll_adjustments adj
           JOIN salary_components comp ON comp.tenant_id=adj.tenant_id AND comp.id=adj.component_id
          WHERE adj.tenant_id=$1 AND adj.payroll_period_id=$2
            AND (adj.status='approved' AND adj.applied_run_item_id IS NULL
                 -- a correction revision carries forward what the finalised revision before it already paid
                 OR (adj.status='applied' AND EXISTS (SELECT 1 FROM payroll_run_items pi JOIN payroll_runs pr ON pr.tenant_id=pi.tenant_id AND pr.id=pi.payroll_run_id
                      WHERE pi.tenant_id=adj.tenant_id AND pi.id=adj.applied_run_item_id AND pr.id<>$3 AND pr.status IN ('locked','payslips_generated'))))`, [a.tenantId, period.id, runId])).rows;

      const problems: ExceptionDraft[] = []; const excluded: typeof emps = []; const inputs: EmployeeInput[] = []; const used = new Set<string>();
      const flagged = new Set<string>();
      for (const e of emps) {
        const asg = assigned.get(e.id);
        if (!asg) { excluded.push(e); continue; }
        const d = days.get(e.id)!;
        const built = buildComponents(e, structures.get(asg.structureId) ?? [], ovs.get(asg.id), asg.monthlyCtc, d.paidDays, rules, problems);
        built.ruleIds.forEach((x) => used.add(x));
        if (problems.some((p) => p.employeeId === e.id)) flagged.add(e.id);
        inputs.push({
          employeeId: e.id, components: built.components, workingDays: d.workingDays, paidDays: d.paidDays, salaryAssignmentId: asg.id,
          adjustments: adjRows.filter((x) => x.employee_id === e.id).map((x) => ({ id: x.id, componentCode: x.code, kind: x.kind, amount: x.amount, reason: x.reason })),
          ...(flagged.has(e.id) ? { flags: ['SETUP_PROBLEM'] } : {}),
        });
      }
      let result;
      try {
        result = calculateRun({ runId, periodCode: period.code, employees: inputs, rules: [...used].map((id) => rules.rules.get(id)!) });
      } catch (err) {
        throw new ApiError('validation_failed', 422, `The payroll could not be calculated: ${(err as Error).message}`);
      }

      // Replace any earlier calculation output.
      await c.query(`DELETE FROM payroll_exceptions WHERE tenant_id=$1 AND payroll_run_id=$2 AND stage='calculation'`, [a.tenantId, runId]);
      const itemIds = new Map<string, string>();
      for (const res of result.employees) {
        const input = inputs.find((i) => i.employeeId === res.employeeId)!;
        const it = (await c.query<{ id: string }>(
          `INSERT INTO payroll_run_items (tenant_id, payroll_run_id, employee_id, salary_assignment_id, input_snapshot, working_days, paid_days, unpaid_days, gross_earnings, employee_deductions, employer_contributions, net_pay, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [a.tenantId, runId, res.employeeId, input.salaryAssignmentId, JSON.stringify(input), res.workingDays, res.paidDays, res.unpaidDays, res.grossEarnings, res.employeeDeductions, res.employerContributions, res.netPay, res.status])).rows[0]!;
        itemIds.set(res.employeeId, it.id);
        for (const l of res.lines) {
          await c.query(
            `INSERT INTO payroll_line_items (tenant_id, payroll_run_item_id, component_code, component_version_id, component_label_snapshot, component_type, calculation_method, calculation_base, applied_rate, amount, rule_set_id, display_order, trace)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [a.tenantId, it.id, l.componentCode, l.versionId ?? null, l.label, l.type, l.method, l.calculationBase ?? null, l.appliedRate ?? null, l.amount, l.ruleId ?? null, l.displayOrder, JSON.stringify(l.trace)]);
        }
      }
      for (const e of excluded) {
        const it = (await c.query<{ id: string }>(`INSERT INTO payroll_run_items (tenant_id, payroll_run_id, employee_id, input_snapshot, status) VALUES ($1,$2,$3,$4,'excluded') RETURNING id`,
          [a.tenantId, runId, e.id, JSON.stringify({ reason: 'no_salary_assignment' })])).rows[0]!;
        itemIds.set(e.id, it.id);
      }
      const exs = [...problems.map((p) => ({ ...p, severity: p.severity })), ...result.exceptions];
      for (const x of exs) {
        await c.query(`INSERT INTO payroll_exceptions (tenant_id, payroll_run_id, payroll_run_item_id, employee_id, stage, severity, code, message, details) VALUES ($1,$2,$3,$4,'calculation',$5,$6,$7,$8)`,
          [a.tenantId, runId, x.employeeId ? itemIds.get(x.employeeId) ?? null : null, x.employeeId ?? null, x.severity, x.code, x.message, JSON.stringify(x.details ?? {})]);
      }
      for (const x of excluded) {
        await c.query(`INSERT INTO payroll_exceptions (tenant_id, payroll_run_id, payroll_run_item_id, employee_id, stage, severity, code, message) VALUES ($1,$2,$3,$4,'calculation','warning','EMPLOYEE_EXCLUDED',$5)`,
          [a.tenantId, runId, itemIds.get(x.id)!, x.id, `${x.name} (${x.number}) was left out of this run: no approved salary assignment`]);
      }
      for (const ruleId of used) await c.query('INSERT INTO payroll_run_rule_sets (tenant_id, payroll_run_id, rule_set_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [a.tenantId, runId, ruleId]);
      for (const adj of adjRows) {
        const itemId = itemIds.get(adj.employee_id);
        if (adj.status === 'approved' && itemId && inputs.some((i) => i.employeeId === adj.employee_id)) await c.query(`UPDATE payroll_adjustments SET status='applied', applied_run_item_id=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, adj.id, itemId]);
      }
      await c.query(
        `UPDATE payroll_runs SET status='calculated', engine_version=$3, input_hash=$4, rule_bundle_hash=$5, total_gross=$6, total_employee_deductions=$7, total_employer_contributions=$8, total_net_pay=$9,
            validation_summary=$10 WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, runId, result.engineVersion ?? ENGINE_VERSION, result.inputHash, result.ruleBundleHash, result.totals.gross, result.totals.employeeDeductions, result.totals.employerContributions, result.totals.netPay,
          JSON.stringify({ employees: inputs.length, excluded: excluded.length, exceptions: exs.length })]);
      await this.audit.record(c, a, 'payroll_run.calculate', 'payroll_runs', runId, null, { employees: inputs.length, excluded: excluded.length, net: result.totals.netPay });
      return this.loadRunView(c, a, runId);
    });
  }

  /** Back to draft so the run can be validated and calculated again. */
  async reopen(a: RequestAuth, runId: string): Promise<RunView> {
    return this.db.run(ctxOf(a, 'payroll run reopened'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['validated', 'calculated', 'rejected'], 'reopened');
      await c.query(
        `UPDATE payroll_runs SET status='draft', submitted_by=NULL, submitted_at=NULL, approved_by=NULL, approved_at=NULL, validated_at=NULL, calculated_at=NULL, engine_version=NULL, input_hash=NULL, rule_bundle_hash=NULL,
            total_gross=NULL, total_employee_deductions=NULL, total_employer_contributions=NULL, total_net_pay=NULL WHERE tenant_id=$1 AND id=$2`, [a.tenantId, runId]);
      await c.query(`UPDATE payroll_adjustments SET status='approved', applied_run_item_id=NULL WHERE tenant_id=$1 AND status='applied' AND applied_run_item_id IN (SELECT id FROM payroll_run_items WHERE tenant_id=$1 AND payroll_run_id=$2)`, [a.tenantId, runId]);
      await c.query(`DELETE FROM payroll_exceptions WHERE tenant_id=$1 AND payroll_run_id=$2 AND stage IN ('calculation','review')`, [a.tenantId, runId]);
      await c.query(`DELETE FROM payroll_line_items WHERE tenant_id=$1 AND payroll_run_item_id IN (SELECT id FROM payroll_run_items WHERE tenant_id=$1 AND payroll_run_id=$2)`, [a.tenantId, runId]);
      await c.query('DELETE FROM payroll_run_items WHERE tenant_id=$1 AND payroll_run_id=$2', [a.tenantId, runId]);
      await c.query('DELETE FROM payroll_run_rule_sets WHERE tenant_id=$1 AND payroll_run_id=$2', [a.tenantId, runId]);
      await this.audit.record(c, a, 'payroll_run.reopen', 'payroll_runs', runId, { status: r.status }, { status: 'draft' });
      return this.loadRunView(c, a, runId);
    });
  }

  async cancel(a: RequestAuth, runId: string): Promise<RunView> {
    return this.db.run(ctxOf(a, 'payroll run cancelled'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['draft', 'validated', 'calculated', 'rejected'], 'cancelled');
      await c.query(`UPDATE payroll_adjustments SET status='approved', applied_run_item_id=NULL WHERE tenant_id=$1 AND status='applied' AND applied_run_item_id IN (SELECT id FROM payroll_run_items WHERE tenant_id=$1 AND payroll_run_id=$2)`, [a.tenantId, runId]);
      await c.query(`UPDATE payroll_runs SET status='cancelled' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, runId]);
      const other = await c.query(`SELECT 1 FROM payroll_runs WHERE tenant_id=$1 AND payroll_period_id=$2 AND status<>'cancelled'`, [a.tenantId, r.payroll_period_id]);
      if (!other.rowCount) await c.query(`UPDATE payroll_periods SET status='open' WHERE tenant_id=$1 AND id=$2 AND status='processing'`, [a.tenantId, r.payroll_period_id]);
      await this.audit.record(c, a, 'payroll_run.cancel', 'payroll_runs', runId, { status: r.status }, { status: 'cancelled' });
      return this.loadRunView(c, a, runId);
    });
  }

  async resolveException(a: RequestAuth, exceptionId: string, body: unknown): Promise<ExceptionView> {
    const b = resolveException.parse(body);
    const runId = await this.db.run(ctxOf(a, 'payroll exception resolved'), async (c) => {
      const x = (await c.query<{ payroll_run_id: string; status: string }>('SELECT payroll_run_id, status FROM payroll_exceptions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, exceptionId])).rows[0];
      if (!x) throw notFound('exception');
      const r = await this.lockRun(c, a, x.payroll_run_id);
      this.requireStatus(r, ['draft', 'validated', 'calculated', 'under_review', 'rejected'], 'changed');
      if (x.status !== 'open') throw new ApiError('invalid_state', 409, `This exception is already ${x.status}`);
      await c.query('UPDATE payroll_exceptions SET status=$3, resolved_by=$4, resolved_at=now(), resolution_note=$5 WHERE tenant_id=$1 AND id=$2', [a.tenantId, exceptionId, b.status, a.userId, b.note]);
      await this.audit.record(c, a, `payroll_exception.${b.status}`, 'payroll_exceptions', exceptionId, { status: 'open' }, { status: b.status }, b.note);
      return x.payroll_run_id;
    });
    const all = await this.listExceptions(a, runId);
    return all.find((e) => e.id === exceptionId)!;
  }

  async submit(a: RequestAuth, runId: string): Promise<RunView> {
    return this.db.run(ctxOf(a, 'payroll run submitted'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['calculated'], 'submitted');
      await c.query(`UPDATE payroll_runs SET status='under_review', submitted_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, runId, a.userId]);
      await this.audit.record(c, a, 'payroll_run.submit', 'payroll_runs', runId, { status: 'calculated' }, { status: 'under_review' });
      return this.loadRunView(c, a, runId);
    });
  }
  async approve(a: RequestAuth, runId: string): Promise<RunView> {
    return this.db.run(ctxOf(a, 'payroll run approved'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['under_review'], 'approved');
      await c.query(`UPDATE payroll_runs SET status='approved', approved_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, runId, a.userId]);
      await this.audit.record(c, a, 'payroll_run.approve', 'payroll_runs', runId, { status: 'under_review' }, { status: 'approved' });
      return this.loadRunView(c, a, runId);
    });
  }
  async reject(a: RequestAuth, runId: string, body: unknown): Promise<RunView> {
    const b = rejectRun.parse(body);
    return this.db.run(ctxOf(a, 'payroll run rejected'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['under_review', 'approved'], 'rejected');
      await c.query(`UPDATE payroll_runs SET status='rejected', rejection_reason=$3, rejected_by=$4 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, runId, b.reason, a.userId]);
      await this.audit.record(c, a, 'payroll_run.reject', 'payroll_runs', runId, { status: r.status }, { status: 'rejected' }, b.reason);
      return this.loadRunView(c, a, runId);
    });
  }

  /** Locks the run, closes the period and issues payslip records (documents are rendered separately). */
  async finalize(a: RequestAuth, runId: string): Promise<RunView> {
    return this.db.run(ctxOf(a, 'payroll run finalised'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['approved'], 'finalised');
      await c.query(`UPDATE payroll_runs SET status='locked', locked_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, runId, a.userId]);
      await c.query(
        `INSERT INTO payslips (tenant_id, payroll_run_item_id, employee_id, revision, issued_at)
         SELECT i.tenant_id, i.id, i.employee_id, $3, now() FROM payroll_run_items i WHERE i.tenant_id=$1 AND i.payroll_run_id=$2 AND i.status<>'excluded'`, [a.tenantId, runId, r.revision]);
      if (r.revision > 1) {
        await c.query(
          `UPDATE payslips s SET status='superseded' WHERE s.tenant_id=$1 AND s.revision < $3 AND s.status <> 'superseded'
              AND s.employee_id IN (SELECT employee_id FROM payroll_run_items WHERE tenant_id=$1 AND payroll_run_id=$2 AND status<>'excluded')
              AND s.payroll_run_item_id IN (SELECT i.id FROM payroll_run_items i JOIN payroll_runs pr ON pr.tenant_id=i.tenant_id AND pr.id=i.payroll_run_id WHERE i.tenant_id=$1 AND pr.payroll_period_id=$4)`,
          [a.tenantId, runId, r.revision, r.payroll_period_id]);
      }
      await c.query(`UPDATE payroll_runs SET status='payslips_generated' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, runId]);
      await c.query(`UPDATE payroll_periods SET status='closed' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, r.payroll_period_id]);
      await this.producer.enqueue(c, {
        tenantId: a.tenantId, type: 'payroll.finalized', aggregateType: 'payroll_runs', aggregateId: runId, idempotencyKey: `payroll-finalized:${runId}`, payload: { periodId: r.payroll_period_id, revision: r.revision }, correlationId: a.requestId,
      });
      await this.audit.record(c, a, 'payroll_run.finalize', 'payroll_runs', runId, { status: 'approved' }, { status: 'payslips_generated' });
      return this.loadRunView(c, a, runId);
    });
  }

  async correct(a: RequestAuth, runId: string, body: unknown): Promise<RunView> {
    const b = correctRun.parse(body);
    return this.db.run(ctxOf(a, 'payroll correction started'), async (c) => {
      const r = await this.lockRun(c, a, runId);
      this.requireStatus(r, ['locked', 'payslips_generated'], 'corrected');
      const latest = (await c.query<{ revision: number }>('SELECT max(revision) AS revision FROM payroll_runs WHERE tenant_id=$1 AND payroll_period_id=$2', [a.tenantId, r.payroll_period_id])).rows[0]!.revision;
      if (latest !== r.revision) throw new ApiError('conflict', 409, 'A newer revision already exists for this period');
      const n = (await c.query<{ id: string }>(
        `INSERT INTO payroll_runs (tenant_id, payroll_period_id, revision, run_kind, correction_of_run_id, correction_reason, created_by) VALUES ($1,$2,$3,'correction',$4,$5,$6) RETURNING id`,
        [a.tenantId, r.payroll_period_id, r.revision + 1, runId, b.reason, a.userId])).rows[0]!;
      await c.query(`UPDATE payroll_periods SET status='processing' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, r.payroll_period_id]);
      await this.audit.record(c, a, 'payroll_run.correct', 'payroll_runs', n.id, null, { correctionOf: runId, revision: r.revision + 1 }, b.reason);
      return this.loadRunView(c, a, n.id);
    });
  }

  // ---- adjustments ---------------------------------------------------------------------------------------------------
  private static readonly ADJ_SELECT = `SELECT adj.id, adj.employee_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.branch_id, adj.payroll_period_id, adj.component_id,
      adj.kind, adj.amount::text, adj.reason, adj.source, adj.status, adj.created_by, adj.approved_by
    FROM payroll_adjustments adj JOIN employees e ON e.tenant_id=adj.tenant_id AND e.id=adj.employee_id`;
  private adjView = (r: Record<string, unknown>): AdjustmentView => ({
    id: r.id as string, employeeId: r.employee_id as string, employeeName: r.employee_name as string, payrollPeriodId: r.payroll_period_id as string, componentId: r.component_id as string,
    kind: r.kind as 'earning' | 'deduction', amount: r.amount as string, reason: r.reason as string, source: r.source as string, status: r.status as string,
    createdBy: (r.created_by as string | null) ?? null, approvedBy: (r.approved_by as string | null) ?? null,
  });
  async listAdjustments(a: RequestAuth, q: { periodId?: string; employeeId?: string; status?: string }): Promise<AdjustmentView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const params: unknown[] = [a.tenantId, q.periodId ?? null, q.employeeId ?? null, q.status ?? null];
      const scope = this.scopeSql(a, 'e', params);
      return (await c.query(`${PayrollService.ADJ_SELECT} WHERE adj.tenant_id=$1 AND ($2::uuid IS NULL OR adj.payroll_period_id=$2) AND ($3::uuid IS NULL OR adj.employee_id=$3) AND ($4::text IS NULL OR adj.status=$4) ${scope} ORDER BY adj.created_at DESC LIMIT 200`, params)).rows.map(this.adjView);
    });
  }
  async createAdjustment(a: RequestAuth, body: unknown): Promise<AdjustmentView> {
    const b = createAdjustment.parse(body);
    return this.db.run(ctxOf(a, 'payroll adjustment created'), async (c) => {
      const e = (await c.query<{ branch_id: string | null; pay_group_id: string | null }>('SELECT branch_id, pay_group_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.employeeId])).rows[0];
      if (!e) throw notFound('employee');
      const d = authorizeOnEmployee(a, 'payroll.manage_adjustments', { tenantId: a.tenantId, branchId: e.branch_id, employeeId: b.employeeId });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
      const { period } = await this.loadPeriod(c, a, b.payrollPeriodId);
      if (period.status === 'closed' || period.status === 'archived') throw new ApiError('invalid_state', 409, 'This period is closed; use a correction run');
      if (e.pay_group_id !== period.payGroupId) throw new ApiError('validation_failed', 422, "The employee is not in this period's pay group", [{ path: 'payrollPeriodId', message: 'pay group mismatch' }]);
      const comp = (await c.query<{ component_type: string }>('SELECT component_type FROM salary_components WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.componentId])).rows[0];
      if (!comp) throw new ApiError('validation_failed', 422, 'Unknown component', [{ path: 'componentId', message: 'not found' }]);
      if (comp.component_type !== (b.kind === 'earning' ? 'earning' : 'employee_deduction')) throw new ApiError('validation_failed', 422, `A ${b.kind} adjustment needs a matching component type`, [{ path: 'componentId', message: 'component type mismatch' }]);
      const r = (await c.query<{ id: string }>(
        `INSERT INTO payroll_adjustments (tenant_id, employee_id, payroll_period_id, component_id, kind, amount, reason, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.tenantId, b.employeeId, b.payrollPeriodId, b.componentId, b.kind, b.amount, b.reason, b.source, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'payroll_adjustment.create', 'payroll_adjustments', r.id, null, { employeeId: b.employeeId, kind: b.kind, amount: b.amount }, b.reason);
      return this.adjView((await c.query(`${PayrollService.ADJ_SELECT} WHERE adj.tenant_id=$1 AND adj.id=$2`, [a.tenantId, r.id])).rows[0]!);
    });
  }
  async reviewAdjustment(a: RequestAuth, id: string, action: 'approve' | 'reject', body: unknown): Promise<AdjustmentView> {
    const b = reviewAdjustment.parse(body ?? {});
    return this.db.run(ctxOf(a, `payroll adjustment ${action}`), async (c) => {
      const cur = (await c.query<{ status: string; created_by: string | null; branch_id: string | null; employee_id: string }>(
        `SELECT adj.status, adj.created_by, e.branch_id, adj.employee_id FROM payroll_adjustments adj JOIN employees e ON e.tenant_id=adj.tenant_id AND e.id=adj.employee_id WHERE adj.tenant_id=$1 AND adj.id=$2 FOR UPDATE OF adj`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('adjustment');
      const d = authorizeOnEmployee(a, 'payroll.approve_adjustment', { tenantId: a.tenantId, branchId: cur.branch_id, employeeId: cur.employee_id });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('adjustment');
      if (cur.created_by === a.userId) throw new ApiError('maker_checker_violation', 403, 'You cannot approve an adjustment you created');
      if (cur.status !== 'draft') throw new ApiError('invalid_state', 409, `This adjustment is already ${cur.status}`);
      if (action === 'approve') await c.query(`UPDATE payroll_adjustments SET status='approved', approved_by=$3, approved_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.userId]);
      else await c.query(`UPDATE payroll_adjustments SET status='rejected' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await this.audit.record(c, a, `payroll_adjustment.${action}`, 'payroll_adjustments', id, { status: 'draft' }, { status: action === 'approve' ? 'approved' : 'rejected' }, b.comment);
      return this.adjView((await c.query(`${PayrollService.ADJ_SELECT} WHERE adj.tenant_id=$1 AND adj.id=$2`, [a.tenantId, id])).rows[0]!);
    });
  }
  async cancelAdjustment(a: RequestAuth, id: string): Promise<AdjustmentView> {
    return this.db.run(ctxOf(a, 'payroll adjustment cancelled'), async (c) => {
      const cur = (await c.query<{ status: string; created_by: string | null; branch_id: string | null; employee_id: string }>(
        `SELECT adj.status, adj.created_by, e.branch_id, adj.employee_id FROM payroll_adjustments adj JOIN employees e ON e.tenant_id=adj.tenant_id AND e.id=adj.employee_id WHERE adj.tenant_id=$1 AND adj.id=$2 FOR UPDATE OF adj`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('adjustment');
      const d = authorizeOnEmployee(a, 'payroll.manage_adjustments', { tenantId: a.tenantId, branchId: cur.branch_id, employeeId: cur.employee_id });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('adjustment');
      if (!['draft', 'approved'].includes(cur.status)) throw new ApiError('invalid_state', 409, `A ${cur.status} adjustment cannot be cancelled`);
      await c.query(`UPDATE payroll_adjustments SET status='cancelled' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      await this.audit.record(c, a, 'payroll_adjustment.cancel', 'payroll_adjustments', id, { status: cur.status }, { status: 'cancelled' });
      return this.adjView((await c.query(`${PayrollService.ADJ_SELECT} WHERE adj.tenant_id=$1 AND adj.id=$2`, [a.tenantId, id])).rows[0]!);
    });
  }

  // ---- payslips ---------------------------------------------------------------------------------------------------
  private async payslipView(c: PoolClient, a: RequestAuth, id: string): Promise<{ view: PayslipView; branchId: string | null }> {
    const p = (await c.query(
      `SELECT s.id, s.employee_id, s.revision, s.status, s.issued_at, s.payroll_run_item_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.branch_id, per.period_code,
              i.working_days::text, i.paid_days::text, i.unpaid_days::text, i.gross_earnings::text, i.employee_deductions::text, i.net_pay::text
         FROM payslips s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id
         JOIN payroll_run_items i ON i.tenant_id=s.tenant_id AND i.id=s.payroll_run_item_id
         JOIN payroll_runs r ON r.tenant_id=i.tenant_id AND r.id=i.payroll_run_id JOIN payroll_periods per ON per.tenant_id=r.tenant_id AND per.id=r.payroll_period_id
        WHERE s.tenant_id=$1 AND s.id=$2`, [a.tenantId, id])).rows[0];
    if (!p) throw notFound('payslip');
    const lines = (await c.query(`SELECT component_code, component_label_snapshot, component_type, amount::text FROM payroll_line_items WHERE tenant_id=$1 AND payroll_run_item_id=$2 ORDER BY display_order, component_code`, [a.tenantId, p.payroll_run_item_id])).rows;
    const pick = (t: string) => lines.filter((l) => l.component_type === t).map((l) => ({ code: l.component_code, label: l.component_label_snapshot, amount: l.amount }));
    return {
      branchId: p.branch_id,
      view: {
        id: p.id, employeeId: p.employee_id, employeeName: p.employee_name, periodCode: p.period_code, revision: p.revision, status: p.status, workingDays: p.working_days, paidDays: p.paid_days, unpaidDays: p.unpaid_days,
        earnings: pick('earning'), deductions: pick('employee_deduction'), employerContributions: pick('employer_contribution'),
        grossEarnings: p.gross_earnings, totalDeductions: p.employee_deductions, netPay: p.net_pay, issuedAt: iso(p.issued_at),
      },
    };
  }
  async getPayslip(a: RequestAuth, id: string): Promise<PayslipView> {
    return this.db.run(ctxOf(a), async (c) => {
      const { view, branchId } = await this.payslipView(c, a, id);
      const d = authorizeOnEmployee(a, 'payslip.read_any', { tenantId: a.tenantId, branchId, employeeId: view.employeeId }, { allowOwn: 'payslip.read_own' });
      if (!d.allowed) throw notFound('payslip'); // never reveal that someone else's payslip exists
      return view;
    });
  }
  async payslipLink(a: RequestAuth, id: string): Promise<{ url: string; expiresAt: string }> {
    return this.db.run(ctxOf(a), async (c) => {
      const p = (await c.query<{ status: string; file_id: string | null; employee_id: string; branch_id: string | null }>(
        `SELECT s.status, s.file_id, s.employee_id, e.branch_id FROM payslips s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id WHERE s.tenant_id=$1 AND s.id=$2`, [a.tenantId, id])).rows[0];
      if (!p || !authorizeOnEmployee(a, 'payslip.read_any', { tenantId: a.tenantId, branchId: p.branch_id, employeeId: p.employee_id }, { allowOwn: 'payslip.read_own' }).allowed) throw notFound('payslip');
      if (!p.file_id || !['ready', 'superseded'].includes(p.status)) throw new ApiError('invalid_state', 409, 'The PDF for this payslip is not ready yet');
      return this.files.issueLink(c, a, p.file_id);
    });
  }
  async myPayslips(a: RequestAuth): Promise<Array<{ id: string; periodCode: string; revision: number; status: string; netPay: string; issuedAt: string | null }>> {
    if (!a.employeeId) return [];
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT s.id, per.period_code, s.revision, s.status, i.net_pay::text, s.issued_at FROM payslips s
         JOIN payroll_run_items i ON i.tenant_id=s.tenant_id AND i.id=s.payroll_run_item_id JOIN payroll_runs r ON r.tenant_id=i.tenant_id AND r.id=i.payroll_run_id
         JOIN payroll_periods per ON per.tenant_id=r.tenant_id AND per.id=r.payroll_period_id
        WHERE s.tenant_id=$1 AND s.employee_id=$2 ORDER BY per.period_start DESC, s.revision DESC LIMIT 60`, [a.tenantId, a.employeeId])).rows
      .map((r) => ({ id: r.id, periodCode: r.period_code, revision: r.revision, status: r.status, netPay: r.net_pay, issuedAt: iso(r.issued_at) })));
  }
  async runPayslips(a: RequestAuth, runId: string): Promise<Array<{ id: string; employeeId: string; employeeName: string; status: string; netPay: string }>> {
    return this.db.run(ctxOf(a), async (c) => {
      await this.loadRunView(c, a, runId);
      const params: unknown[] = [a.tenantId, runId];
      const scope = this.scopeSql(a, 'e', params);
      return (await c.query(
        `SELECT s.id, s.employee_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name, s.status, i.net_pay::text FROM payslips s
           JOIN payroll_run_items i ON i.tenant_id=s.tenant_id AND i.id=s.payroll_run_item_id JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id
          WHERE s.tenant_id=$1 AND i.payroll_run_id=$2 ${scope} ORDER BY e.employee_number`, params)).rows
        .map((r) => ({ id: r.id, employeeId: r.employee_id, employeeName: r.name, status: r.status, netPay: r.net_pay }));
    });
  }

  // ---- register export ---------------------------------------------------------------------------------------------
  async register(a: RequestAuth, runId: string, format: 'json' | 'csv'): Promise<{ filename: string; csv?: string; json?: unknown }> {
    return this.db.run(ctxOf(a, 'payroll register export'), async (c) => {
      const run = await this.loadRunView(c, a, runId);
      if (!['calculated', 'under_review', 'approved', 'locked', 'payslips_generated'].includes(run.status)) throw new ApiError('invalid_state', 409, 'The register is available once the run is calculated');
      const params: unknown[] = [a.tenantId, runId];
      const scope = this.scopeSql(a, 'e', params);
      const items = (await c.query(
        `SELECT i.id, e.employee_number, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name, i.working_days::text, i.paid_days::text, i.unpaid_days::text, i.gross_earnings::text,
                i.employee_deductions::text, i.employer_contributions::text, i.net_pay::text, i.status
           FROM payroll_run_items i JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id WHERE i.tenant_id=$1 AND i.payroll_run_id=$2 ${scope} ORDER BY e.employee_number`, params)).rows;
      const lines = items.length ? (await c.query(
        `SELECT payroll_run_item_id, component_code, component_type, amount::text FROM payroll_line_items WHERE tenant_id=$1 AND payroll_run_item_id = ANY($2::uuid[])`, [a.tenantId, items.map((i) => i.id)])).rows : [];
      const cols = [...new Map(lines.map((l) => [`${l.component_type}:${l.component_code}`, { type: l.component_type as string, code: l.component_code as string }])).values()]
        .sort((x, y) => x.type.localeCompare(y.type) || x.code.localeCompare(y.code));
      const label = (k: { type: string; code: string }) => `${k.code} (${k.type === 'earning' ? 'earning' : k.type === 'employee_deduction' ? 'deduction' : k.type === 'employer_contribution' ? 'employer' : 'info'})`;
      const rows = items.map((i) => ({
        employeeNumber: i.employee_number, employeeName: i.name, status: i.status, workingDays: i.working_days, paidDays: i.paid_days, unpaidDays: i.unpaid_days,
        components: Object.fromEntries(cols.map((k) => [label(k), lines.find((l) => l.payroll_run_item_id === i.id && l.component_code === k.code && l.component_type === k.type)?.amount ?? '0.00'])),
        grossEarnings: i.gross_earnings, employeeDeductions: i.employee_deductions, employerContributions: i.employer_contributions, netPay: i.net_pay,
      }));
      await this.audit.record(c, a, 'payroll_register.export', 'payroll_runs', runId, null, { format, rows: rows.length }, 'register export');
      const filename = `payroll-register-${run.periodCode}-r${run.revision}.${format}`;
      if (format === 'json') return { filename, json: rows };
      const head = ['Employee No', 'Name', 'Status', 'Working days', 'Paid days', 'Unpaid days', ...cols.map(label), 'Gross', 'Employee deductions', 'Employer contributions', 'Net pay'];
      const body = rows.map((r) => [r.employeeNumber, r.employeeName, r.status, r.workingDays, r.paidDays, r.unpaidDays, ...cols.map((k) => r.components[label(k)]!), r.grossEarnings, r.employeeDeductions, r.employerContributions, r.netPay]);
      return { filename, csv: [head, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n' };
    });
  }
}

export { csvCell };
