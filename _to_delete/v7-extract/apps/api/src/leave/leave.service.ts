import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { authorizeOnEmployee, hasPermission } from '@humantech/authz';
import {
  LeaveBalanceView, LeaveLedgerEntry, LeavePolicyView, LeaveRequestView, LeaveTypeView, adjustBalance, applyLeave, createLeavePolicy,
  createLeaveType, decideLeave, decodeCursor, encodeCursor, leaveRequestQuery, runAccrual, runYearEnd, updateLeaveType,
} from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { notify } from '../common/notify';
import { ApiError, forbidden, notFound } from '../common/errors';
import { setClause } from '../common/sql';
import { countLeaveDays, halfDaysToString } from './leave-days';

interface TypeRow { id: string; code: string; name: string; is_paid: boolean; requires_approval: boolean; allow_half_day: boolean; max_negative_days: string; active: boolean }
interface ReqRow {
  id: string; employee_id: string; employee_number: string; employee_name: string; branch_id: string | null; employee_user_id: string | null;
  leave_type_id: string; leave_type_code: string; start_date: string; end_date: string; partial_day: 'first_half' | 'second_half' | null;
  requested_days: string; reason: string | null; status: LeaveRequestView['status']; auto_approved: boolean; submitted_at: string;
  decided_by: string | null; decided_at: string | null; decision_comment: string | null; version: number;
}
const TYPE_COLS = 'id, code, name, is_paid, requires_approval, allow_half_day, max_negative_days::text, active';
const REQ_SELECT = `SELECT r.id, r.employee_id, e.employee_number, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
    e.branch_id, e.user_id AS employee_user_id, r.leave_type_id, t.code AS leave_type_code,
    to_char(r.start_date,'YYYY-MM-DD') AS start_date, to_char(r.end_date,'YYYY-MM-DD') AS end_date, r.partial_day,
    r.requested_days::text, r.reason, r.status, r.auto_approved,
    to_char(r.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
    r.decided_by, to_char(r.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at, r.decision_comment, r.version
  FROM leave_requests r
  JOIN employees e ON e.tenant_id = r.tenant_id AND e.id = r.employee_id
  JOIN leave_types t ON t.tenant_id = r.tenant_id AND t.id = r.leave_type_id`;

const typeView = (r: TypeRow): LeaveTypeView => ({
  id: r.id, code: r.code, name: r.name, isPaid: r.is_paid, requiresApproval: r.requires_approval, allowHalfDay: r.allow_half_day,
  maxNegativeDays: r.max_negative_days, active: r.active,
});
const reqView = (r: ReqRow): LeaveRequestView => ({
  id: r.id, employeeId: r.employee_id, employeeNumber: r.employee_number, employeeName: r.employee_name, leaveTypeId: r.leave_type_id,
  leaveTypeCode: r.leave_type_code, startDate: r.start_date, endDate: r.end_date, partialDay: r.partial_day, requestedDays: r.requested_days,
  reason: r.reason, status: r.status, autoApproved: r.auto_approved, submittedAt: r.submitted_at, decidedBy: r.decided_by,
  decidedAt: r.decided_at, decisionComment: r.decision_comment, version: r.version,
});
const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });

@Injectable()
export class LeaveService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  // ---- types ------------------------------------------------------------------------------------
  async listTypes(a: RequestAuth, includeInactive: boolean): Promise<LeaveTypeView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query<TypeRow>(
      `SELECT ${TYPE_COLS} FROM leave_types WHERE tenant_id=$1 ${includeInactive ? '' : 'AND active'} ORDER BY code`, [a.tenantId])).rows.map(typeView));
  }
  async createType(a: RequestAuth, body: unknown): Promise<LeaveTypeView> {
    const b = createLeaveType.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query<TypeRow>(
        `INSERT INTO leave_types (tenant_id, code, name, is_paid, requires_approval, allow_half_day, max_negative_days) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${TYPE_COLS}`,
        [a.tenantId, b.code, b.name, b.isPaid, b.requiresApproval, b.allowHalfDay, b.maxNegativeDays])).rows[0]!;
      await this.audit.record(c, a, 'leave_type.create', 'leave_types', r.id, null, { code: b.code });
      return typeView(r);
    });
  }
  async updateType(a: RequestAuth, id: string, body: unknown): Promise<LeaveTypeView> {
    const b = updateLeaveType.parse(body);
    const changes = { name: b.name, requires_approval: b.requiresApproval, allow_half_day: b.allowHalfDay, max_negative_days: b.maxNegativeDays, active: b.active };
    if (Object.values(changes).every((v) => v === undefined)) throw new ApiError('validation_failed', 422, 'Nothing to update');
    return this.db.run(ctxOf(a), async (c) => {
      const s = setClause(changes, 3);
      const r = (await c.query<TypeRow>(`UPDATE leave_types SET ${s.sql} WHERE tenant_id=$1 AND id=$2 RETURNING ${TYPE_COLS}`, [a.tenantId, id, ...s.params])).rows[0];
      if (!r) throw notFound('leave type');
      await this.audit.record(c, a, 'leave_type.update', 'leave_types', id, null, b);
      return typeView(r);
    });
  }

  // ---- policies ---------------------------------------------------------------------------------
  private policyView(r: Record<string, unknown>): LeavePolicyView {
    return {
      id: r.id as string, leaveTypeId: r.leave_type_id as string, version: r.version as number, effectiveFrom: r.effective_from as string,
      effectiveTo: (r.effective_to as string | null) ?? null, accrualFrequency: r.accrual_frequency as string, accrualDays: r.accrual_days as string,
      eligibleAfterDays: r.eligible_after_days as number, probationEligible: r.probation_eligible as boolean, carryForwardMaxDays: r.carry_forward_max_days as string,
      expiryDays: (r.expiry_days as number | null) ?? null, countWeeklyOffs: r.count_weekly_offs as boolean, countHolidays: r.count_holidays as boolean,
      status: r.status as LeavePolicyView['status'],
    };
  }
  private static readonly POLICY_COLS = `id, leave_type_id, version, to_char(effective_from,'YYYY-MM-DD') AS effective_from, to_char(effective_to,'YYYY-MM-DD') AS effective_to,
    accrual_frequency, accrual_days::text, eligible_after_days, probation_eligible, carry_forward_max_days::text, expiry_days, count_weekly_offs, count_holidays, status`;

  async listPolicies(a: RequestAuth): Promise<LeavePolicyView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT ${LeaveService.POLICY_COLS} FROM leave_policies WHERE tenant_id=$1 ORDER BY leave_type_id, version DESC`, [a.tenantId])).rows.map((r) => this.policyView(r)));
  }
  async createPolicy(a: RequestAuth, body: unknown): Promise<LeavePolicyView> {
    const b = createLeavePolicy.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const v = (await c.query<{ v: number }>('SELECT COALESCE(max(version),0)+1 AS v FROM leave_policies WHERE tenant_id=$1 AND leave_type_id=$2', [a.tenantId, b.leaveTypeId])).rows[0]!.v;
      const r = (await c.query(
        `INSERT INTO leave_policies (tenant_id, leave_type_id, version, effective_from, effective_to, accrual_frequency, accrual_days, eligible_after_days,
            probation_eligible, carry_forward_max_days, expiry_days, count_weekly_offs, count_holidays, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${LeaveService.POLICY_COLS}`,
        [a.tenantId, b.leaveTypeId, v, b.effectiveFrom, b.effectiveTo ?? null, b.accrualFrequency, b.accrualDays, b.eligibleAfterDays, b.probationEligible,
          b.carryForwardMaxDays, b.expiryDays ?? null, b.countWeeklyOffs, b.countHolidays, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'leave_policy.create', 'leave_policies', r.id, null, { leaveTypeId: b.leaveTypeId, version: v });
      return this.policyView(r);
    });
  }
  async setPolicyStatus(a: RequestAuth, id: string, to: 'active' | 'retired'): Promise<LeavePolicyView> {
    return this.db.run(ctxOf(a, `policy ${to}`), async (c) => {
      const cur = (await c.query<{ status: string }>('SELECT status FROM leave_policies WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('leave policy');
      const ok = (to === 'active' && cur.status === 'draft') || (to === 'retired' && cur.status === 'active');
      if (!ok) throw new ApiError('invalid_state', 409, `A ${cur.status} policy cannot become ${to}`);
      const r = (await c.query(`UPDATE leave_policies SET status=$3 WHERE tenant_id=$1 AND id=$2 RETURNING ${LeaveService.POLICY_COLS}`, [a.tenantId, id, to])).rows[0]!;
      await this.audit.record(c, a, `leave_policy.${to}`, 'leave_policies', id, { status: cur.status }, { status: to });
      return this.policyView(r);
    });
  }

  // ---- day counting (reads shifts + holidays) ----------------------------------------------------
  private async dayCount(c: PoolClient, tenantId: string, emp: { id: string; branch_id: string | null }, start: string, end: string, partial: boolean,
    policy: { count_weekly_offs: boolean; count_holidays: boolean } | undefined) {
    const shifts = (await c.query<{ from: string; to: string | null; offs: number[] }>(
      `SELECT to_char(sa.effective_from,'YYYY-MM-DD') AS "from", to_char(sa.effective_to,'YYYY-MM-DD') AS "to", s.weekly_off_days::int[] AS offs
         FROM shift_assignments sa JOIN shifts s ON s.tenant_id=sa.tenant_id AND s.id=sa.shift_id
        WHERE sa.tenant_id=$1 AND sa.employee_id=$2 AND sa.superseded_at IS NULL AND sa.effective_from <= $4 AND COALESCE(sa.effective_to,'infinity'::date) >= $3`,
      [tenantId, emp.id, start, end])).rows;
    const hol = (await c.query<{ d: string }>(
      `SELECT to_char(holiday_date,'YYYY-MM-DD') AS d FROM holidays
        WHERE tenant_id=$1 AND holiday_date BETWEEN $2 AND $3 AND NOT is_optional AND (branch_id IS NULL OR branch_id IS NOT DISTINCT FROM $4)`,
      [tenantId, start, end, emp.branch_id])).rows;
    try {
      return countLeaveDays({
        start, end, partial,
        weeklyOffs: (d) => shifts.find((s) => s.from <= d && (s.to === null || s.to >= d))?.offs ?? [0],   // no shift: Sunday off
        holidays: new Set(hol.map((h) => h.d)),
        countWeeklyOffs: policy?.count_weekly_offs ?? false, countHolidays: policy?.count_holidays ?? false,
      });
    } catch (e) {
      if (e instanceof RangeError) throw new ApiError('validation_failed', 422, e.message, [{ path: 'endDate', message: e.message }]);
      throw e;
    }
  }

  private async today(c: PoolClient, tenantId: string): Promise<string> {
    return (await c.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE COALESCE((SELECT timezone FROM tenants WHERE id=$1),'Asia/Kolkata'))::date,'YYYY-MM-DD') AS d`, [tenantId])).rows[0]!.d;
  }

  // ---- authorisation helpers ---------------------------------------------------------------------
  private canView(a: RequestAuth, e: { id: string; branch_id: string | null }): boolean {
    if (e.id === a.employeeId && hasPermission(a, 'leave.read_own')) return true;
    if (hasPermission(a, 'leave.read_all') && (a.branchScope.mode === 'all' || (e.branch_id && a.branchScope.branchIds.has(e.branch_id)) || a.teamEmployeeIds?.has(e.id))) return true;
    if (hasPermission(a, 'leave.read_team') && a.teamEmployeeIds?.has(e.id)) return true;
    return false;
  }
  private assertDecider(a: RequestAuth, perm: 'leave.approve' | 'leave.reject', e: { id: string; branch_id: string | null }): void {
    const d = authorizeOnEmployee(a, perm, { tenantId: a.tenantId, branchId: e.branch_id, employeeId: e.id }, { allowTeam: true });
    if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('leave request');
  }

  // ---- requests -----------------------------------------------------------------------------------
  private async loadRequest(c: PoolClient, a: RequestAuth, id: string, lock = false): Promise<ReqRow> {
    const r = (await c.query<ReqRow>(`${REQ_SELECT} WHERE r.tenant_id=$1 AND r.id=$2 ${lock ? 'FOR UPDATE OF r' : ''}`, [a.tenantId, id])).rows[0];
    if (!r) throw notFound('leave request');
    return r;
  }

  async get(a: RequestAuth, id: string): Promise<LeaveRequestView> {
    return this.db.run(ctxOf(a), async (c) => {
      const r = await this.loadRequest(c, a, id);
      if (!this.canView(a, { id: r.employee_id, branch_id: r.branch_id })) throw notFound('leave request');
      return reqView(r);
    });
  }

  async list(a: RequestAuth, query: unknown): Promise<{ data: LeaveRequestView[]; nextCursor: string | null; limit: number }> {
    const q = leaveRequestQuery.parse(query);
    const params: unknown[] = [a.tenantId];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const visible: string[] = [];
    if (a.employeeId && hasPermission(a, 'leave.read_own')) visible.push(`r.employee_id = ${add(a.employeeId)}`);
    const team = [...(a.teamEmployeeIds ?? [])];
    if (hasPermission(a, 'leave.read_all')) {
      if (a.branchScope.mode === 'all') visible.push('true');
      else visible.push(`(e.branch_id = ANY(${add([...a.branchScope.branchIds])}::uuid[]) OR r.employee_id = ANY(${add(team)}::uuid[]))`);
    } else if (hasPermission(a, 'leave.read_team')) visible.push(`r.employee_id = ANY(${add(team)}::uuid[])`);
    if (visible.length === 0) throw forbidden();
    const where = ['r.tenant_id = $1', `(${visible.join(' OR ')})`];
    if (q.status) where.push(`r.status = ${add(q.status)}`);
    if (q.employeeId) where.push(`r.employee_id = ${add(q.employeeId)}`);
    if (q.from) where.push(`r.end_date >= ${add(q.from)}`);
    if (q.to) where.push(`r.start_date <= ${add(q.to)}`);
    if (q.cursor) {
      let k: Array<string | number>;
      try { k = decodeCursor(q.cursor); } catch { k = []; }
      if (k.length !== 2 || typeof k[0] !== 'string' || typeof k[1] !== 'string' || Number.isNaN(Date.parse(k[0])) || !/^[0-9a-f-]{36}$/.test(k[1])) {
        throw new ApiError('validation_failed', 422, 'Invalid cursor', [{ path: 'cursor', message: 'invalid cursor' }]);
      }
      where.push(`(r.created_at, r.id) < (${add(k[0])}::timestamptz, ${add(k[1])}::uuid)`);
    }
    const rows = await this.db.run(ctxOf(a), async (c) => (await c.query<ReqRow & { created_key: string }>(
      `SELECT x.*, to_char(cr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key FROM (${REQ_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ${add(q.limit + 1)}) x
         JOIN leave_requests cr ON cr.tenant_id=$1 AND cr.id=x.id ORDER BY cr.created_at DESC, cr.id DESC`, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { data: page.map(reqView), limit: q.limit, nextCursor: rows.length > q.limit && last ? encodeCursor([last.created_key, last.id]) : null };
  }

  async apply(a: RequestAuth, body: unknown): Promise<LeaveRequestView> {
    const b = applyLeave.parse(body);
    const onBehalf = b.employeeId !== undefined && b.employeeId !== a.employeeId;
    const empId = b.employeeId ?? a.employeeId;
    if (!empId) throw new ApiError('validation_failed', 422, 'You do not have an employee profile; specify employeeId', [{ path: 'employeeId', message: 'required' }]);
    if (!onBehalf && !hasPermission(a, 'leave.request')) throw forbidden();

    return this.db.run(ctxOf(a, 'leave requested'), async (c) => {
      const emp = (await c.query<{ id: string; branch_id: string | null; employment_status: string }>(
        'SELECT id, branch_id, employment_status FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, empId])).rows[0];
      if (!emp) throw notFound('employee');
      if (onBehalf) this.assertDecider(a, 'leave.approve', emp);
      if (!['active', 'probation', 'on_notice'].includes(emp.employment_status)) throw new ApiError('invalid_state', 409, 'Leave can only be requested for active employees');

      const type = (await c.query<TypeRow>(`SELECT ${TYPE_COLS} FROM leave_types WHERE tenant_id=$1 AND id=$2`, [a.tenantId, b.leaveTypeId])).rows[0];
      if (!type || !type.active) throw new ApiError('validation_failed', 422, 'Unknown or inactive leave type', [{ path: 'leaveTypeId', message: 'unknown leave type' }]);
      if (b.partialDay && !type.allow_half_day) throw new ApiError('validation_failed', 422, 'This leave type does not allow half days', [{ path: 'partialDay', message: 'not allowed' }]);

      const policy = (await c.query<{ id: string; count_weekly_offs: boolean; count_holidays: boolean }>(
        `SELECT id, count_weekly_offs, count_holidays FROM leave_policies WHERE tenant_id=$1 AND leave_type_id=$2 AND status='active'
            AND $3::date BETWEEN effective_from AND COALESCE(effective_to,'infinity'::date)`, [a.tenantId, type.id, b.startDate])).rows[0];
      const dc = await this.dayCount(c, a.tenantId, emp, b.startDate, b.endDate, !!b.partialDay, policy);
      if (dc.halfDays === 0) throw new ApiError('validation_failed', 422, 'The selected dates contain no working days', [{ path: 'startDate', message: 'no working days in range' }]);
      const days = halfDaysToString(dc.halfDays);

      if (type.is_paid) {
        const bal = (await c.query<{ bal: string; pend: string }>(
          `SELECT COALESCE((SELECT SUM(days_delta) FROM leave_balance_transactions WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3),0)::text AS bal,
                  COALESCE((SELECT SUM(requested_days) FROM leave_requests WHERE tenant_id=$1 AND employee_id=$2 AND leave_type_id=$3 AND status='pending'),0)::text AS pend`,
          [a.tenantId, emp.id, type.id])).rows[0]!;
        if (Number(bal.bal) - Number(bal.pend) - Number(days) < -Number(type.max_negative_days)) {
          throw new ApiError('insufficient_balance', 409, `Insufficient ${type.code} balance: available ${(Number(bal.bal) - Number(bal.pend)).toFixed(2)}, requested ${days}`);
        }
      }

      const auto = !type.requires_approval;
      const ins = (await c.query<{ id: string }>(
        `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, leave_policy_id, start_date, end_date, partial_day, requested_days, reason, status, auto_approved, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [a.tenantId, emp.id, type.id, policy?.id ?? null, b.startDate, b.endDate, b.partialDay ?? null, days, b.reason ?? null,
          auto ? 'approved' : 'pending', auto, auto ? new Date() : null])).rows[0]!;
      if (auto) await this.applyApproval(c, a, ins.id, emp.id, type, b.startDate, days, dc.countedDates, !!b.partialDay);
      await this.audit.record(c, a, 'leave.apply', 'leave_requests', ins.id, null, { employeeId: emp.id, type: type.code, start: b.startDate, end: b.endDate, days, auto });
      return reqView(await this.loadRequest(c, a, ins.id));
    });
  }

  /** Ledger usage + attendance projection for an approved request. Runs inside the caller's transaction. */
  private async applyApproval(c: PoolClient, a: RequestAuth, requestId: string, employeeId: string, type: TypeRow, startDate: string, days: string, dates: string[], partial: boolean): Promise<void> {
    if (type.is_paid) {
      await c.query(
        `INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, source_request_id, transaction_type, days_delta, effective_date, idempotency_key, actor_user_id)
         VALUES ($1,$2,$3,$4,'usage',$5,$6,$7,$8)`,
        [a.tenantId, employeeId, type.id, requestId, `-${days}`, startDate, `leave-usage:${requestId}`, a.userId]);
    }
    if (!partial) {
      await c.query(
        `INSERT INTO attendance_days (tenant_id, employee_id, work_date, attendance_status, paid_day_fraction, source, approval_status, created_by)
         SELECT $1,$2,d::date,'leave',$4,'system','approved',$5 FROM unnest($3::date[]) AS d
         ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET attendance_status='leave', paid_day_fraction=EXCLUDED.paid_day_fraction, source='system'
           WHERE attendance_days.attendance_status IN ('absent','not_marked')`,
        [a.tenantId, employeeId, dates, type.is_paid ? 1 : 0, a.userId]);
    }
  }

  async decide(a: RequestAuth, id: string, action: 'approve' | 'reject', body: unknown): Promise<LeaveRequestView> {
    const b = decideLeave.parse(body);
    if (action === 'reject' && !b.comment) throw new ApiError('validation_failed', 422, 'A reason is required to reject leave', [{ path: 'comment', message: 'required' }]);
    return this.db.run(ctxOf(a, `leave ${action}`), async (c) => {
      const r = await this.loadRequest(c, a, id, true);
      this.assertDecider(a, action === 'approve' ? 'leave.approve' : 'leave.reject', { id: r.employee_id, branch_id: r.branch_id });
      if (r.version !== b.version) throw new ApiError('version_conflict', 409, 'This request was changed by someone else; reload and try again');
      if (r.status !== 'pending') throw new ApiError('invalid_state', 409, `This request is already ${r.status}`);
      await c.query(`UPDATE leave_requests SET status=$3, decided_by=$4, decided_at=now(), decision_comment=$5 WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, action === 'approve' ? 'approved' : 'rejected', a.userId, b.comment ?? null]);
      if (action === 'approve') {
        const type = (await c.query<TypeRow>(`SELECT ${TYPE_COLS} FROM leave_types WHERE tenant_id=$1 AND id=$2`, [a.tenantId, r.leave_type_id])).rows[0]!;
        const policy = (await c.query<{ count_weekly_offs: boolean; count_holidays: boolean }>(
          `SELECT count_weekly_offs, count_holidays FROM leave_policies WHERE tenant_id=$1 AND id=(SELECT leave_policy_id FROM leave_requests WHERE tenant_id=$1 AND id=$2)`, [a.tenantId, id])).rows[0];
        const dc = await this.dayCount(c, a.tenantId, { id: r.employee_id, branch_id: r.branch_id }, r.start_date, r.end_date, !!r.partial_day, policy);
        await this.applyApproval(c, a, id, r.employee_id, type, r.start_date, r.requested_days, dc.countedDates, !!r.partial_day);
      }
      await this.audit.record(c, a, `leave.${action}`, 'leave_requests', id, { status: 'pending' }, { status: action === 'approve' ? 'approved' : 'rejected' }, b.comment);
      const who = (await c.query<{ user_id: string | null }>('SELECT user_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, r.employee_id])).rows[0]?.user_id;
      await notify(c, { tenantId: a.tenantId, userIds: [who], eventKey: `leave.${action === 'approve' ? 'approved' : 'rejected'}`, dedupeKey: `leave-decision:${id}`,
        title: `Your leave request (${r.start_date}${r.end_date !== r.start_date ? ` to ${r.end_date}` : ''}) was ${action === 'approve' ? 'approved' : 'rejected'}`, body: b.comment, data: { leaveRequestId: id } });
      return reqView(await this.loadRequest(c, a, id));
    });
  }

  async cancel(a: RequestAuth, id: string, body: unknown): Promise<LeaveRequestView> {
    const b = decideLeave.parse(body);
    return this.db.run(ctxOf(a, 'leave cancelled'), async (c) => {
      const r = await this.loadRequest(c, a, id, true);
      const own = r.employee_id === a.employeeId;
      if (!own) this.assertDecider(a, 'leave.approve', { id: r.employee_id, branch_id: r.branch_id });
      if (r.version !== b.version) throw new ApiError('version_conflict', 409, 'This request was changed by someone else; reload and try again');
      if (r.status !== 'pending' && r.status !== 'approved') throw new ApiError('invalid_state', 409, `A ${r.status} request cannot be cancelled`);
      if (own && !hasPermission(a, 'leave.request')) throw forbidden();
      if (own && r.status === 'approved' && r.start_date <= (await this.today(c, a.tenantId))) {
        throw new ApiError('invalid_state', 409, 'Approved leave that has started can only be cancelled by a manager or HR');
      }
      const wasApproved = r.status === 'approved';
      await c.query(`UPDATE leave_requests SET status='cancelled', cancelled_by=$3, cancelled_at=now(), decision_comment=COALESCE($4, decision_comment) WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, a.userId, b.comment ?? null]);
      if (wasApproved) {
        const type = (await c.query<TypeRow>(`SELECT ${TYPE_COLS} FROM leave_types WHERE tenant_id=$1 AND id=$2`, [a.tenantId, r.leave_type_id])).rows[0]!;
        if (type.is_paid) {
          await c.query(
            `INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, source_request_id, transaction_type, days_delta, effective_date, reason, idempotency_key, actor_user_id)
             VALUES ($1,$2,$3,$4,'reversal',$5,$6,'Leave cancelled',$7,$8)`,
            [a.tenantId, r.employee_id, type.id, id, r.requested_days, r.start_date, `leave-reversal:${id}`, a.userId]);
        }
        await c.query(`DELETE FROM attendance_days WHERE tenant_id=$1 AND employee_id=$2 AND work_date BETWEEN $3 AND $4 AND attendance_status='leave' AND source='system'`,
          [a.tenantId, r.employee_id, r.start_date, r.end_date]);
      }
      await this.audit.record(c, a, 'leave.cancel', 'leave_requests', id, { status: r.status }, { status: 'cancelled' }, b.comment);
      return reqView(await this.loadRequest(c, a, id));
    });
  }

  // ---- balances -----------------------------------------------------------------------------------
  private async employeeFor(c: PoolClient, a: RequestAuth, employeeId: string | undefined): Promise<{ id: string; branch_id: string | null }> {
    const id = employeeId ?? a.employeeId;
    if (!id) throw new ApiError('validation_failed', 422, 'No employee specified', [{ path: 'employeeId', message: 'required' }]);
    const e = (await c.query<{ id: string; branch_id: string | null }>('SELECT id, branch_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
    if (!e || !this.canView(a, e)) throw notFound('employee');
    return e;
  }

  async balances(a: RequestAuth, employeeId?: string): Promise<LeaveBalanceView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const e = await this.employeeFor(c, a, employeeId);
      return (await c.query<{ id: string; code: string; name: string; bal: string; pend: string }>(
        `SELECT t.id, t.code, t.name,
                COALESCE((SELECT SUM(days_delta) FROM leave_balance_transactions x WHERE x.tenant_id=t.tenant_id AND x.employee_id=$2 AND x.leave_type_id=t.id),0)::numeric(10,2)::text AS bal,
                COALESCE((SELECT SUM(requested_days) FROM leave_requests r WHERE r.tenant_id=t.tenant_id AND r.employee_id=$2 AND r.leave_type_id=t.id AND r.status='pending'),0)::numeric(10,2)::text AS pend
           FROM leave_types t WHERE t.tenant_id=$1 AND t.active AND t.is_paid ORDER BY t.code`, [a.tenantId, e.id])).rows
        .map((r) => ({ leaveTypeId: r.id, leaveTypeCode: r.code, leaveTypeName: r.name, balanceDays: r.bal, pendingDays: r.pend, availableDays: (Number(r.bal) - Number(r.pend)).toFixed(2) }));
    });
  }

  async ledger(a: RequestAuth, employeeId: string, leaveTypeId?: string): Promise<LeaveLedgerEntry[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const e = await this.employeeFor(c, a, employeeId);
      const params: unknown[] = [a.tenantId, e.id];
      if (leaveTypeId) params.push(leaveTypeId);
      return (await c.query(
        `SELECT id, transaction_type, days_delta::text, to_char(effective_date,'YYYY-MM-DD') AS effective_date, reason, source_request_id,
                to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
           FROM leave_balance_transactions WHERE tenant_id=$1 AND employee_id=$2 ${leaveTypeId ? 'AND leave_type_id=$3' : ''}
          ORDER BY effective_date DESC, created_at DESC LIMIT 500`, params)).rows
        .map((r) => ({ id: r.id, transactionType: r.transaction_type, daysDelta: r.days_delta, effectiveDate: r.effective_date, reason: r.reason, sourceRequestId: r.source_request_id, createdAt: r.created_at }));
    });
  }

  async adjust(a: RequestAuth, body: unknown, idempotencyKey?: string): Promise<LeaveBalanceView[]> {
    const b = adjustBalance.parse(body);
    if (b.kind === 'opening_grant' && Number(b.days) < 0) throw new ApiError('validation_failed', 422, 'An opening grant must be positive', [{ path: 'days', message: 'must be positive' }]);
    await this.db.run(ctxOf(a, b.reason), async (c) => {
      const e = (await c.query<{ id: string; branch_id: string | null }>('SELECT id, branch_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.employeeId])).rows[0];
      if (!e) throw notFound('employee');
      const d = authorizeOnEmployee(a, 'leave.adjust_balance', { tenantId: a.tenantId, branchId: e.branch_id, employeeId: e.id }, { allowTeam: false });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
      const t = (await c.query('SELECT 1 FROM leave_types WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.leaveTypeId])).rowCount;
      if (!t) throw new ApiError('validation_failed', 422, 'Unknown leave type', [{ path: 'leaveTypeId', message: 'unknown leave type' }]);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, reason, idempotency_key, actor_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
        [a.tenantId, b.employeeId, b.leaveTypeId, b.kind, b.days, b.effectiveDate, b.reason, idempotencyKey ? `adjust:${idempotencyKey}` : `adjust:${a.requestId}`, a.userId]);
      if (ins.rows[0]) await this.audit.record(c, a, 'leave.adjust', 'leave_balance_transactions', ins.rows[0].id, null, { employeeId: b.employeeId, days: b.days, kind: b.kind }, b.reason);
    });
    return this.balances(a, b.employeeId);
  }

  // ---- scheduled rules ----------------------------------------------------------------------------
  async accrue(a: RequestAuth, body: unknown): Promise<{ granted: number; asOf: string }> {
    const b = runAccrual.parse(body);
    return this.db.run(ctxOf(a, 'leave accrual'), async (c) => {
      const asOf = b.asOf ?? (await this.today(c, a.tenantId));
      const granted = (await c.query<{ n: number }>('SELECT app.accrue_leave($1::date) AS n', [asOf])).rows[0]!.n;
      await this.audit.record(c, a, 'leave.accrue', 'leave_balance_transactions', null, null, { asOf, granted });
      return { granted, asOf };
    });
  }
  async yearEnd(a: RequestAuth, body: unknown): Promise<{ lapsed: number; year: number }> {
    const b = runYearEnd.parse(body);
    return this.db.run(ctxOf(a, 'leave year end'), async (c) => {
      const lapsed = (await c.query<{ n: number }>('SELECT app.expire_leave($1::int) AS n', [b.year])).rows[0]!.n;
      await this.audit.record(c, a, 'leave.year_end', 'leave_balance_transactions', null, null, { year: b.year, lapsed });
      return { lapsed, year: b.year };
    });
  }
}
