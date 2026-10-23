import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { authorizeOnEmployee, hasPermission } from '@humantech/authz';
import {
  AttendanceDayView, AttendancePolicyView, AttendanceSummaryView, CorrectionView, ShiftView, assignShift, attendanceDaysQuery, createAttendancePolicy,
  createShift, decodeCursor, encodeCursor, finalizeDay, importEvents, lockAttendance, markAttendance, requestCorrection, reviewCorrection, summaryQuery, updateShift,
} from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { ApiError, forbidden, notFound } from '../common/errors';
import { DerivePolicy, ShiftTimes, deriveDay, fractionFor, lateDeductionDays } from './derive';

const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const badCursor = () => new ApiError('validation_failed', 422, 'Invalid cursor', [{ path: 'cursor', message: 'invalid cursor' }]);

interface EmpRef { id: string; branch_id: string | null; user_id?: string | null }
interface DayRow {
  id: string; employee_id: string; employee_number: string; employee_name: string; work_date: string; attendance_status: string;
  check_in_at: Date | null; check_out_at: Date | null; worked_minutes: number | null; late_minutes: number; overtime_minutes: number;
  paid_day_fraction: string; source: string; approval_status: 'pending' | 'approved' | 'rejected'; correction_version: number;
}
const DAY_SELECT = `SELECT d.id, d.employee_id, e.employee_number, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
    to_char(d.work_date,'YYYY-MM-DD') AS work_date, d.attendance_status, d.check_in_at, d.check_out_at, d.worked_minutes, d.late_minutes, d.overtime_minutes,
    d.paid_day_fraction::text, d.source, d.approval_status, d.correction_version
  FROM attendance_days d JOIN employees e ON e.tenant_id = d.tenant_id AND e.id = d.employee_id`;
const dayView = (r: DayRow): AttendanceDayView => ({
  id: r.id, employeeId: r.employee_id, employeeNumber: r.employee_number, employeeName: r.employee_name, workDate: r.work_date, status: r.attendance_status,
  checkInAt: iso(r.check_in_at), checkOutAt: iso(r.check_out_at), workedMinutes: r.worked_minutes, lateMinutes: r.late_minutes, overtimeMinutes: r.overtime_minutes,
  paidDayFraction: r.paid_day_fraction, source: r.source, approvalStatus: r.approval_status, correctionVersion: r.correction_version,
});

const SHIFT_COLS = `id, code, name, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time, crosses_midnight, grace_minutes,
  half_day_minutes, full_day_minutes, weekly_off_days::int[] AS weekly_off_days, status`;
const POLICY_COLS = `id, name, version, to_char(effective_from,'YYYY-MM-DD') AS effective_from, to_char(effective_to,'YYYY-MM-DD') AS effective_to,
  late_after_grace_counts_as_late, late_marks_per_half_day, missing_punch_policy, allow_employee_checkin, correction_window_days, overtime_enabled, status`;

@Injectable()
export class AttendanceService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  // ---- shifts -----------------------------------------------------------------------------------
  private shiftView(r: Record<string, unknown>): ShiftView {
    return {
      id: r.id as string, code: r.code as string, name: r.name as string, startTime: r.start_time as string, endTime: r.end_time as string,
      crossesMidnight: r.crosses_midnight as boolean, graceMinutes: r.grace_minutes as number, halfDayMinutes: r.half_day_minutes as number,
      fullDayMinutes: r.full_day_minutes as number, weeklyOffDays: r.weekly_off_days as number[], status: r.status as string,
    };
  }
  async listShifts(a: RequestAuth, includeInactive: boolean): Promise<ShiftView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT ${SHIFT_COLS} FROM shifts WHERE tenant_id=$1 ${includeInactive ? '' : `AND status='active'`} ORDER BY code`, [a.tenantId])).rows.map((r) => this.shiftView(r)));
  }
  async createShift(a: RequestAuth, body: unknown): Promise<ShiftView> {
    const b = createShift.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(
        `INSERT INTO shifts (tenant_id, code, name, start_time, end_time, grace_minutes, half_day_minutes, full_day_minutes, weekly_off_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${SHIFT_COLS}`,
        [a.tenantId, b.code, b.name, b.startTime, b.endTime, b.graceMinutes, b.halfDayMinutes, b.fullDayMinutes, b.weeklyOffDays])).rows[0]!;
      await this.audit.record(c, a, 'shift.create', 'shifts', r.id, null, { code: b.code });
      return this.shiftView(r);
    });
  }
  async updateShift(a: RequestAuth, id: string, body: unknown): Promise<ShiftView> {
    const b = updateShift.parse(body);
    const changes = { name: b.name, grace_minutes: b.graceMinutes, half_day_minutes: b.halfDayMinutes, full_day_minutes: b.fullDayMinutes, weekly_off_days: b.weeklyOffDays, status: b.status };
    if (Object.values(changes).every((v) => v === undefined)) throw new ApiError('validation_failed', 422, 'Nothing to update');
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(
        `UPDATE shifts SET name=COALESCE($3,name), grace_minutes=COALESCE($4,grace_minutes), half_day_minutes=COALESCE($5,half_day_minutes),
                full_day_minutes=COALESCE($6,full_day_minutes), weekly_off_days=COALESCE($7::smallint[],weekly_off_days), status=COALESCE($8,status)
          WHERE tenant_id=$1 AND id=$2 RETURNING ${SHIFT_COLS}`,
        [a.tenantId, id, b.name ?? null, b.graceMinutes ?? null, b.halfDayMinutes ?? null, b.fullDayMinutes ?? null, b.weeklyOffDays ?? null, b.status ?? null])).rows[0];
      if (!r) throw notFound('shift');
      await this.audit.record(c, a, 'shift.update', 'shifts', id, null, b);
      return this.shiftView(r);
    });
  }

  private async loadEmployee(c: PoolClient, a: RequestAuth, id: string): Promise<EmpRef> {
    const e = (await c.query<EmpRef>('SELECT id, branch_id, user_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
    if (!e) throw notFound('employee');
    return e;
  }
  private assertCan(a: RequestAuth, perm: 'attendance.manage_policy' | 'attendance.mark' | 'attendance.correct' | 'attendance.approve_correction', e: EmpRef): void {
    const d = authorizeOnEmployee(a, perm, { tenantId: a.tenantId, branchId: e.branch_id, employeeId: e.id }, { allowTeam: perm !== 'attendance.manage_policy' });
    if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
  }
  private canView(a: RequestAuth, e: EmpRef): boolean {
    if (e.id === a.employeeId && hasPermission(a, 'attendance.read_own')) return true;
    return hasPermission(a, 'attendance.read') && (a.branchScope.mode === 'all' || (!!e.branch_id && a.branchScope.branchIds.has(e.branch_id)) || !!a.teamEmployeeIds?.has(e.id));
  }

  async listAssignments(a: RequestAuth, employeeId: string): Promise<Array<{ id: string; shiftId: string; shiftCode: string; effectiveFrom: string; effectiveTo: string | null }>> {
    return this.db.run(ctxOf(a), async (c) => {
      const e = await this.loadEmployee(c, a, employeeId).catch(() => null);
      if (!e || !this.canView(a, e)) throw notFound('employee');
      return (await c.query(
        `SELECT sa.id, sa.shift_id, s.code, to_char(sa.effective_from,'YYYY-MM-DD') AS f, to_char(sa.effective_to,'YYYY-MM-DD') AS t
           FROM shift_assignments sa JOIN shifts s ON s.tenant_id=sa.tenant_id AND s.id=sa.shift_id
          WHERE sa.tenant_id=$1 AND sa.employee_id=$2 AND sa.superseded_at IS NULL ORDER BY sa.effective_from DESC`, [a.tenantId, employeeId])).rows
        .map((r) => ({ id: r.id, shiftId: r.shift_id, shiftCode: r.code, effectiveFrom: r.f, effectiveTo: r.t }));
    });
  }

  async assign(a: RequestAuth, body: unknown): Promise<{ id: string }> {
    const b = assignShift.parse(body);
    return this.db.run(ctxOf(a, 'shift assigned'), async (c) => {
      const e = await this.loadEmployee(c, a, b.employeeId);
      this.assertCan(a, 'attendance.manage_policy', e);
      const shift = (await c.query<{ status: string }>('SELECT status FROM shifts WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.shiftId])).rows[0];
      if (!shift || shift.status !== 'active') throw new ApiError('validation_failed', 422, 'Unknown or inactive shift', [{ path: 'shiftId', message: 'unknown shift' }]);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [`${a.tenantId}${b.employeeId}`]);
      // Same start date: supersede. Earlier start still running: end it the day before.
      await c.query(`UPDATE shift_assignments SET superseded_at = now() WHERE tenant_id=$1 AND employee_id=$2 AND superseded_at IS NULL AND effective_from = $3`, [a.tenantId, b.employeeId, b.effectiveFrom]);
      await c.query(
        `UPDATE shift_assignments SET effective_to = $3::date - 1 WHERE tenant_id=$1 AND employee_id=$2 AND superseded_at IS NULL
            AND effective_from < $3 AND (effective_to IS NULL OR effective_to >= $3)`, [a.tenantId, b.employeeId, b.effectiveFrom]);
      const r = (await c.query<{ id: string }>(
        `INSERT INTO shift_assignments (tenant_id, employee_id, shift_id, effective_from, effective_to, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [a.tenantId, b.employeeId, b.shiftId, b.effectiveFrom, b.effectiveTo ?? null, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'shift.assign', 'shift_assignments', r.id, null, b);
      return r;
    });
  }

  // ---- attendance policies ----------------------------------------------------------------------------
  private policyView(r: Record<string, unknown>): AttendancePolicyView {
    return {
      id: r.id as string, name: r.name as string, version: r.version as number, effectiveFrom: r.effective_from as string, effectiveTo: (r.effective_to as string | null) ?? null,
      lateAfterGraceCountsAsLate: r.late_after_grace_counts_as_late as boolean, lateMarksPerHalfDay: (r.late_marks_per_half_day as number | null) ?? null,
      missingPunchPolicy: r.missing_punch_policy as AttendancePolicyView['missingPunchPolicy'], allowEmployeeCheckin: r.allow_employee_checkin as boolean,
      correctionWindowDays: r.correction_window_days as number, overtimeEnabled: r.overtime_enabled as boolean, status: r.status as AttendancePolicyView['status'],
    };
  }
  async listPolicies(a: RequestAuth): Promise<AttendancePolicyView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(`SELECT ${POLICY_COLS} FROM attendance_policies WHERE tenant_id=$1 ORDER BY effective_from DESC, version DESC`, [a.tenantId])).rows.map((r) => this.policyView(r)));
  }
  async createPolicy(a: RequestAuth, body: unknown): Promise<AttendancePolicyView> {
    const b = createAttendancePolicy.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const v = (await c.query<{ v: number }>('SELECT COALESCE(max(version),0)+1 AS v FROM attendance_policies WHERE tenant_id=$1 AND name=$2', [a.tenantId, b.name])).rows[0]!.v;
      const r = (await c.query(
        `INSERT INTO attendance_policies (tenant_id, name, version, effective_from, effective_to, late_after_grace_counts_as_late, late_marks_per_half_day,
            missing_punch_policy, allow_employee_checkin, correction_window_days, overtime_enabled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${POLICY_COLS}`,
        [a.tenantId, b.name, v, b.effectiveFrom, b.effectiveTo ?? null, b.lateAfterGraceCountsAsLate, b.lateMarksPerHalfDay ?? null, b.missingPunchPolicy,
          b.allowEmployeeCheckin, b.correctionWindowDays, b.overtimeEnabled, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'attendance_policy.create', 'attendance_policies', r.id, null, { name: b.name, version: v });
      return this.policyView(r);
    });
  }
  async setPolicyStatus(a: RequestAuth, id: string, to: 'active' | 'retired'): Promise<AttendancePolicyView> {
    return this.db.run(ctxOf(a, `policy ${to}`), async (c) => {
      const cur = (await c.query<{ status: string }>('SELECT status FROM attendance_policies WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('attendance policy');
      if (!((to === 'active' && cur.status === 'draft') || (to === 'retired' && cur.status === 'active'))) throw new ApiError('invalid_state', 409, `A ${cur.status} policy cannot become ${to}`);
      const r = (await c.query(`UPDATE attendance_policies SET status=$3 WHERE tenant_id=$1 AND id=$2 RETURNING ${POLICY_COLS}`, [a.tenantId, id, to])).rows[0]!;
      await this.audit.record(c, a, `attendance_policy.${to}`, 'attendance_policies', id, { status: cur.status }, { status: to });
      return this.policyView(r);
    });
  }

  // ---- derivation plumbing ----------------------------------------------------------------------------
  private async tz(c: PoolClient, tenantId: string): Promise<string> {
    return (await c.query<{ tz: string }>(`SELECT COALESCE((SELECT timezone FROM tenants WHERE id=$1),'Asia/Kolkata') AS tz`, [tenantId])).rows[0]!.tz;
  }
  private async today(c: PoolClient, tenantId: string): Promise<string> {
    return (await c.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date,'YYYY-MM-DD') AS d`, [await this.tz(c, tenantId)])).rows[0]!.d;
  }
  private async activePolicy(c: PoolClient, tenantId: string, date: string): Promise<(DerivePolicy & { row: AttendancePolicyView }) | null> {
    const r = (await c.query(`SELECT ${POLICY_COLS} FROM attendance_policies WHERE tenant_id=$1 AND status='active' AND $2::date BETWEEN effective_from AND COALESCE(effective_to,'infinity'::date)`, [tenantId, date])).rows[0];
    if (!r) return null;
    const row = this.policyView(r);
    return { missingPunchPolicy: row.missingPunchPolicy, lateCounts: row.lateAfterGraceCountsAsLate, overtimeEnabled: row.overtimeEnabled, row };
  }
  private async shiftFor(c: PoolClient, tenantId: string, employeeId: string, date: string, tz: string): Promise<(ShiftTimes & { assignmentId: string; weeklyOffs: number[] }) | null> {
    const r = (await c.query<{ aid: string; start_at: Date; grace_minutes: number; half_day_minutes: number; full_day_minutes: number; offs: number[] }>(
      `SELECT sa.id AS aid, (($3::date + s.start_time) AT TIME ZONE $4) AS start_at, s.grace_minutes, s.half_day_minutes, s.full_day_minutes, s.weekly_off_days::int[] AS offs
         FROM shift_assignments sa JOIN shifts s ON s.tenant_id=sa.tenant_id AND s.id=sa.shift_id
        WHERE sa.tenant_id=$1 AND sa.employee_id=$2 AND sa.superseded_at IS NULL AND sa.effective_from <= $3 AND COALESCE(sa.effective_to,'infinity'::date) >= $3 LIMIT 1`,
      [tenantId, employeeId, date, tz])).rows[0];
    return r ? { assignmentId: r.aid, start: r.start_at, graceMinutes: r.grace_minutes, halfDayMinutes: r.half_day_minutes, fullDayMinutes: r.full_day_minutes, weeklyOffs: r.offs } : null;
  }

  /** Writes the day row. Punch-derived unless an explicit status is given. */
  private async saveDay(c: PoolClient, a: RequestAuth, o: {
    employeeId: string; workDate: string; checkIn: Date | null; checkOut: Date | null; closed: boolean; source: string;
    status?: string; approval?: 'pending' | 'approved'; bumpVersion?: boolean;
  }): Promise<AttendanceDayView> {
    const tz = await this.tz(c, a.tenantId);
    const [shift, policy] = await Promise.all([this.shiftFor(c, a.tenantId, o.employeeId, o.workDate, tz), this.activePolicy(c, a.tenantId, o.workDate)]);
    const d = deriveDay(shift, policy, o.checkIn, o.checkOut, o.closed);
    const status = o.status ?? d.status;
    const fraction = o.status ? fractionFor(o.status) : d.paidFraction;
    const worked = d.workedMinutes;
    const approval = o.approval ?? (!o.status && d.needsReview ? 'pending' : 'approved');
    const row = (await c.query<{ id: string }>(
      `INSERT INTO attendance_days (tenant_id, employee_id, work_date, shift_assignment_id, attendance_status, check_in_at, check_out_at, worked_minutes, late_minutes,
                                     overtime_minutes, paid_day_fraction, source, approval_status, approved_at, approved_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $13='approved' THEN now() END, CASE WHEN $13='approved' THEN $14::uuid END, $14)
       ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET
         shift_assignment_id=EXCLUDED.shift_assignment_id, attendance_status=EXCLUDED.attendance_status, check_in_at=EXCLUDED.check_in_at, check_out_at=EXCLUDED.check_out_at,
         worked_minutes=EXCLUDED.worked_minutes, late_minutes=EXCLUDED.late_minutes, overtime_minutes=EXCLUDED.overtime_minutes, paid_day_fraction=EXCLUDED.paid_day_fraction,
         source=EXCLUDED.source, approval_status=EXCLUDED.approval_status, approved_at=EXCLUDED.approved_at, approved_by=EXCLUDED.approved_by,
         correction_version = attendance_days.correction_version + ${o.bumpVersion ? 1 : 0}
       RETURNING id`,
      [a.tenantId, o.employeeId, o.workDate, shift?.assignmentId ?? null, status, o.checkIn, o.checkOut, worked, d.lateMinutes, d.overtimeMinutes, fraction, o.source, approval, a.userId])).rows[0]!;
    return dayView((await c.query<DayRow>(`${DAY_SELECT} WHERE d.tenant_id=$1 AND d.id=$2`, [a.tenantId, row.id])).rows[0]!);
  }

  private async existingDay(c: PoolClient, tenantId: string, employeeId: string, date: string, lock = false) {
    return (await c.query<{ id: string; attendance_status: string; check_in_at: Date | null; check_out_at: Date | null; source: string; approval_status: string }>(
      `SELECT id, attendance_status, check_in_at, check_out_at, source, approval_status FROM attendance_days WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3 ${lock ? 'FOR UPDATE' : ''}`,
      [tenantId, employeeId, date])).rows[0];
  }

  // ---- reading days ---------------------------------------------------------------------------------------
  async days(a: RequestAuth, query: unknown): Promise<{ data: AttendanceDayView[]; nextCursor: string | null; limit: number }> {
    const q = attendanceDaysQuery.parse(query);
    const params: unknown[] = [a.tenantId, q.from, q.to];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const visible: string[] = [];
    if (a.employeeId && hasPermission(a, 'attendance.read_own')) visible.push(`d.employee_id = ${add(a.employeeId)}`);
    if (hasPermission(a, 'attendance.read')) {
      if (a.branchScope.mode === 'all') visible.push('true');
      else visible.push(`(e.branch_id = ANY(${add([...a.branchScope.branchIds])}::uuid[]) OR d.employee_id = ANY(${add([...(a.teamEmployeeIds ?? [])])}::uuid[]))`);
    }
    if (visible.length === 0) throw forbidden();
    const where = ['d.tenant_id = $1', 'd.work_date BETWEEN $2 AND $3', `(${visible.join(' OR ')})`];
    if (q.employeeId) where.push(`d.employee_id = ${add(q.employeeId)}`);
    if (q.status) where.push(`d.attendance_status = ${add(q.status)}`);
    if (q.cursor) {
      let k: Array<string | number> = [];
      try { k = decodeCursor(q.cursor); } catch { /* handled below */ }
      if (k.length !== 2 || typeof k[0] !== 'string' || typeof k[1] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k[0]) || !/^[0-9a-f-]{36}$/.test(k[1])) throw badCursor();
      where.push(`(d.work_date, d.id) < (${add(k[0])}::date, ${add(k[1])}::uuid)`);
    }
    const rows = await this.db.run(ctxOf(a), async (c) =>
      (await c.query<DayRow>(`${DAY_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.work_date DESC, d.id DESC LIMIT ${add(q.limit + 1)}`, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { data: page.map(dayView), limit: q.limit, nextCursor: rows.length > q.limit && last ? encodeCursor([last.work_date, last.id]) : null };
  }

  // ---- manual marking ---------------------------------------------------------------------------------------
  async mark(a: RequestAuth, body: unknown): Promise<AttendanceDayView> {
    const b = markAttendance.parse(body);
    return this.db.run(ctxOf(a, b.reason), async (c) => {
      const e = await this.loadEmployee(c, a, b.employeeId);
      this.assertCan(a, 'attendance.mark', e);
      const today = await this.today(c, a.tenantId);
      if (b.workDate > today) throw new ApiError('validation_failed', 422, 'Attendance cannot be marked for a future date', [{ path: 'workDate', message: 'in the future' }]);
      const cur = await this.existingDay(c, a.tenantId, b.employeeId, b.workDate, true);
      if (cur?.attendance_status === 'leave') throw new ApiError('invalid_state', 409, 'This day is covered by approved leave; cancel the leave first');
      const checkIn = b.checkInAt !== undefined ? (b.checkInAt ? new Date(b.checkInAt) : null) : cur?.check_in_at ?? null;
      const checkOut = b.checkOutAt !== undefined ? (b.checkOutAt ? new Date(b.checkOutAt) : null) : cur?.check_out_at ?? null;
      const out = await this.saveDay(c, a, { employeeId: b.employeeId, workDate: b.workDate, checkIn, checkOut, closed: b.workDate < today, source: 'manual', status: b.status, approval: 'approved', bumpVersion: !!cur });
      await this.audit.record(c, a, 'attendance.mark', 'attendance_days', out.id, cur ? { status: cur.attendance_status } : null, { status: out.status, checkInAt: out.checkInAt, checkOutAt: out.checkOutAt }, b.reason);
      return out;
    });
  }

  // ---- employee self punch -------------------------------------------------------------------------------------
  async punch(a: RequestAuth, type: 'check_in' | 'check_out', idempotencyKey?: string): Promise<AttendanceDayView> {
    if (!a.employeeId) throw new ApiError('validation_failed', 422, 'You do not have an employee profile');
    const employeeId = a.employeeId;
    return this.db.run(ctxOf(a, `self ${type}`), async (c) => {
      const today = await this.today(c, a.tenantId);
      const policy = await this.activePolicy(c, a.tenantId, today);
      if (!policy?.row.allowEmployeeCheckin) throw new ApiError('invalid_state', 409, 'Self check-in is not enabled for your company');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 3))', [`${a.tenantId}${employeeId}`]);
      const cur = await this.existingDay(c, a.tenantId, employeeId, today, true);
      if (cur && cur.attendance_status !== 'present' && cur.attendance_status !== 'not_marked' && cur.attendance_status !== 'work_from_home') {
        throw new ApiError('invalid_state', 409, `Today is already recorded as ${cur.attendance_status.replace('_', ' ')}`);
      }
      if (type === 'check_in' && cur?.check_in_at) throw new ApiError('invalid_state', 409, cur.check_out_at ? 'You have already completed today' : 'You are already checked in');
      if (type === 'check_out' && (!cur?.check_in_at || cur.check_out_at)) throw new ApiError('invalid_state', 409, cur?.check_out_at ? 'You have already checked out today' : 'Check in first');
      const now = new Date();
      const key = `self:${employeeId}:${today}:${type}:${idempotencyKey ?? 'auto'}`;
      const ins = await c.query(
        `INSERT INTO attendance_events (tenant_id, employee_id, event_type, occurred_at, source, idempotency_key, created_by) VALUES ($1,$2,$3,$4,'employee_checkin',$5,$6)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`, [a.tenantId, employeeId, type, now, key, a.userId]);
      if (!ins.rowCount) return dayView((await c.query<DayRow>(`${DAY_SELECT} WHERE d.tenant_id=$1 AND d.employee_id=$2 AND d.work_date=$3`, [a.tenantId, employeeId, today])).rows[0]!);
      const out = await this.saveDay(c, a, {
        employeeId, workDate: today, checkIn: type === 'check_in' ? now : cur?.check_in_at ?? null, checkOut: type === 'check_out' ? now : null,
        closed: type === 'check_out', source: 'employee_checkin', approval: 'approved',
      });
      await this.audit.record(c, a, `attendance.${type}`, 'attendance_days', out.id, null, { at: now.toISOString() });
      return out;
    });
  }

  async importPunches(a: RequestAuth, body: unknown): Promise<{ accepted: number; duplicates: number }> {
    const b = importEvents.parse(body);
    return this.db.run(ctxOf(a, 'attendance import'), async (c) => {
      const ids = [...new Set(b.events.map((e) => e.employeeId))];
      const emps = (await c.query<EmpRef>('SELECT id, branch_id FROM employees WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [a.tenantId, ids])).rows;
      if (emps.length !== ids.length) throw notFound('employee');
      for (const e of emps) this.assertCan(a, 'attendance.mark', e);
      const tz = await this.tz(c, a.tenantId);
      const today = await this.today(c, a.tenantId);
      let accepted = 0; let duplicates = 0;
      const ordered = [...b.events].sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt));
      for (const ev of ordered) {
        const at = new Date(ev.occurredAt);
        const ins = await c.query(
          `INSERT INTO attendance_events (tenant_id, employee_id, event_type, occurred_at, source, device_reference, idempotency_key, created_by)
           VALUES ($1,$2,$3,$4,'device_import',$5,$6,$7) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
          [a.tenantId, ev.employeeId, ev.type, at, ev.deviceReference ?? null, `import:${ev.idempotencyKey}`, a.userId]);
        if (!ins.rowCount) { duplicates++; continue; }
        accepted++;
        const local = (await c.query<{ d: string; p: string }>(`SELECT to_char(($1::timestamptz AT TIME ZONE $2)::date,'YYYY-MM-DD') AS d, to_char((($1::timestamptz AT TIME ZONE $2)::date - 1),'YYYY-MM-DD') AS p`, [at, tz])).rows[0]!;
        let workDate = local.d;
        if (ev.type === 'check_out') {
          // Night shifts: a check-out with no same-day check-in belongs to yesterday's open punch.
          const same = await this.existingDay(c, a.tenantId, ev.employeeId, local.d);
          const prev = await this.existingDay(c, a.tenantId, ev.employeeId, local.p);
          if (!same?.check_in_at && prev?.check_in_at && !prev.check_out_at && at.getTime() - prev.check_in_at.getTime() < 24 * 3_600_000) workDate = local.p;
        }
        const cur = await this.existingDay(c, a.tenantId, ev.employeeId, workDate, true);
        if (cur && !['present', 'not_marked', 'work_from_home', 'half_day', 'absent'].includes(cur.attendance_status)) continue;     // leave/holiday/weekly-off days keep their status
        const checkIn = ev.type === 'check_in' ? (cur?.check_in_at && cur.check_in_at < at ? cur.check_in_at : at) : cur?.check_in_at ?? null;
        const checkOut = ev.type === 'check_out' ? (cur?.check_out_at && cur.check_out_at > at ? cur.check_out_at : at) : cur?.check_out_at ?? null;
        await this.saveDay(c, a, { employeeId: ev.employeeId, workDate, checkIn, checkOut, closed: workDate < today || !!checkOut, source: 'device_import', bumpVersion: false });
      }
      await this.audit.record(c, a, 'attendance.import', 'attendance_events', null, null, { accepted, duplicates });
      return { accepted, duplicates };
    });
  }

  // ---- corrections ------------------------------------------------------------------------------------------------
  private corrView(r: Record<string, unknown>): CorrectionView {
    return {
      id: r.id as string, attendanceDayId: r.attendance_day_id as string, employeeId: r.employee_id as string, employeeName: r.employee_name as string,
      workDate: r.work_date as string, previous: r.previous_values as Record<string, unknown>, requested: r.requested_values as Record<string, unknown>,
      reason: r.reason as string, status: r.status as CorrectionView['status'], requestedBy: (r.requested_by as string | null) ?? null,
      reviewedBy: (r.reviewed_by as string | null) ?? null, reviewComment: (r.review_comment as string | null) ?? null, createdAt: r.created_at as string,
    };
  }
  private static readonly CORR_SELECT = `SELECT k.id, k.attendance_day_id, d.employee_id, e.branch_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
      to_char(d.work_date,'YYYY-MM-DD') AS work_date, k.previous_values, k.requested_values, k.reason, k.status, k.requested_by, k.reviewed_by, k.review_comment,
      to_char(k.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM attendance_corrections k
    JOIN attendance_days d ON d.tenant_id=k.tenant_id AND d.id=k.attendance_day_id
    JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id`;

  async requestCorrection(a: RequestAuth, body: unknown): Promise<CorrectionView> {
    const b = requestCorrection.parse(body);
    const empId = b.employeeId ?? a.employeeId;
    if (!empId) throw new ApiError('validation_failed', 422, 'No employee specified', [{ path: 'employeeId', message: 'required' }]);
    const own = empId === a.employeeId;
    if (own && !hasPermission(a, 'attendance.request_correction_own')) throw forbidden();
    return this.db.run(ctxOf(a, b.reason), async (c) => {
      const e = await this.loadEmployee(c, a, empId);
      if (!own) this.assertCan(a, 'attendance.correct', e);
      const today = await this.today(c, a.tenantId);
      if (b.workDate > today) throw new ApiError('validation_failed', 422, 'Corrections cannot be requested for a future date', [{ path: 'workDate', message: 'in the future' }]);
      const policy = await this.activePolicy(c, a.tenantId, b.workDate);
      const windowDays = policy?.row.correctionWindowDays ?? 7;
      const age = (await c.query<{ n: number }>('SELECT ($1::date - $2::date) AS n', [today, b.workDate])).rows[0]!.n;
      if (age > windowDays) throw new ApiError('validation_failed', 422, `Corrections are only accepted within ${windowDays} days`, [{ path: 'workDate', message: 'outside the correction window' }]);
      let day = await this.existingDay(c, a.tenantId, empId, b.workDate, true);
      if (day?.attendance_status === 'leave') throw new ApiError('invalid_state', 409, 'This day is covered by approved leave');
      if (!day) {
        const id = (await c.query<{ id: string }>(`INSERT INTO attendance_days (tenant_id, employee_id, work_date, attendance_status, paid_day_fraction, source, approval_status, created_by)
          VALUES ($1,$2,$3,'not_marked',0,'system','approved',$4) RETURNING id`, [a.tenantId, empId, b.workDate, a.userId])).rows[0]!.id;
        day = { id, attendance_status: 'not_marked', check_in_at: null, check_out_at: null, source: 'system', approval_status: 'approved' };
      }
      const dup = await c.query(`SELECT 1 FROM attendance_corrections WHERE tenant_id=$1 AND attendance_day_id=$2 AND status='pending'`, [a.tenantId, day.id]);
      if (dup.rowCount) throw new ApiError('conflict', 409, 'A correction is already pending for this day');
      const r = (await c.query<{ id: string }>(
        `INSERT INTO attendance_corrections (tenant_id, attendance_day_id, previous_values, requested_values, reason, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [a.tenantId, day.id, JSON.stringify({ status: day.attendance_status, checkInAt: iso(day.check_in_at), checkOutAt: iso(day.check_out_at) }), JSON.stringify(b.requested), b.reason, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'attendance.correction_request', 'attendance_corrections', r.id, null, b.requested, b.reason);
      return this.corrView((await c.query(`${AttendanceService.CORR_SELECT} WHERE k.tenant_id=$1 AND k.id=$2`, [a.tenantId, r.id])).rows[0]!);
    });
  }

  async listCorrections(a: RequestAuth, status?: string): Promise<CorrectionView[]> {
    const params: unknown[] = [a.tenantId];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const visible: string[] = [];
    if (hasPermission(a, 'attendance.request_correction_own')) visible.push(`k.requested_by = ${add(a.userId)}`);
    if (hasPermission(a, 'attendance.approve_correction') || hasPermission(a, 'attendance.correct')) {
      if (a.branchScope.mode === 'all') visible.push('true');
      else visible.push(`(e.branch_id = ANY(${add([...a.branchScope.branchIds])}::uuid[]) OR d.employee_id = ANY(${add([...(a.teamEmployeeIds ?? [])])}::uuid[]))`);
    }
    if (visible.length === 0) throw forbidden();
    const where = ['k.tenant_id = $1', `(${visible.join(' OR ')})`];
    if (status) {
      if (!['pending', 'approved', 'rejected', 'cancelled'].includes(status)) throw new ApiError('validation_failed', 422, 'Invalid status', [{ path: 'status', message: 'invalid' }]);
      where.push(`k.status = ${add(status)}`);
    }
    return this.db.run(ctxOf(a), async (c) => (await c.query(`${AttendanceService.CORR_SELECT} WHERE ${where.join(' AND ')} ORDER BY k.created_at DESC LIMIT 200`, params)).rows.map((r) => this.corrView(r)));
  }

  async reviewCorrection(a: RequestAuth, id: string, action: 'approve' | 'reject' | 'cancel', body: unknown): Promise<CorrectionView> {
    const b = reviewCorrection.parse(body ?? {});
    if (action === 'reject' && !b.comment) throw new ApiError('validation_failed', 422, 'A reason is required to reject a correction', [{ path: 'comment', message: 'required' }]);
    return this.db.run(ctxOf(a, `correction ${action}`), async (c) => {
      const k = (await c.query(`${AttendanceService.CORR_SELECT} WHERE k.tenant_id=$1 AND k.id=$2 FOR UPDATE OF k`, [a.tenantId, id])).rows[0];
      if (!k) throw notFound('correction');
      const e: EmpRef = { id: k.employee_id, branch_id: k.branch_id };
      if (action === 'cancel') {
        if (k.requested_by !== a.userId) throw notFound('correction');   // not yours: indistinguishable from missing
      } else {
        this.assertCan(a, 'attendance.approve_correction', e);
        if (k.requested_by === a.userId) throw new ApiError('maker_checker_violation', 403, 'You cannot review your own correction request');
      }
      if (k.status !== 'pending') throw new ApiError('invalid_state', 409, `This correction is already ${k.status}`);
      if (action === 'approve') {
        const req = k.requested_values as { status?: string; checkInAt?: string | null; checkOutAt?: string | null };
        const cur = await this.existingDay(c, a.tenantId, k.employee_id, k.work_date, true);
        if (cur?.attendance_status === 'leave') throw new ApiError('invalid_state', 409, 'This day is now covered by approved leave');
        const today = await this.today(c, a.tenantId);
        await this.saveDay(c, a, {
          employeeId: k.employee_id, workDate: k.work_date,
          checkIn: req.checkInAt !== undefined ? (req.checkInAt ? new Date(req.checkInAt) : null) : cur?.check_in_at ?? null,
          checkOut: req.checkOutAt !== undefined ? (req.checkOutAt ? new Date(req.checkOutAt) : null) : cur?.check_out_at ?? null,
          closed: k.work_date < today, source: 'manual', status: req.status, approval: 'approved', bumpVersion: true,
        });
      }
      // A cancelling requester is not a "reviewer" (the table forbids reviewer = requester).
      await c.query(`UPDATE attendance_corrections SET status=$3, reviewed_by=$4, reviewed_at=now(), review_comment=$5 WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled', action === 'cancel' ? null : a.userId, b.comment ?? null]);
      await this.audit.record(c, a, `attendance.correction_${action}`, 'attendance_corrections', id, { status: 'pending' }, { status: action }, b.comment);
      return this.corrView((await c.query(`${AttendanceService.CORR_SELECT} WHERE k.tenant_id=$1 AND k.id=$2`, [a.tenantId, id])).rows[0]!);
    });
  }

  // ---- daily close ----------------------------------------------------------------------------------------------------
  async finalize(a: RequestAuth, body: unknown): Promise<{ created: number; closed: number; date: string }> {
    const b = finalizeDay.parse(body);
    return this.db.run(ctxOf(a, 'day finalised'), async (c) => {
      const today = await this.today(c, a.tenantId);
      if (b.date >= today) throw new ApiError('validation_failed', 422, 'Only past days can be finalised', [{ path: 'date', message: 'must be before today' }]);
      const tz = await this.tz(c, a.tenantId);
      const params: unknown[] = [a.tenantId, b.date];
      let scopeSql = '';
      if (a.branchScope.mode === 'listed') { params.push([...a.branchScope.branchIds], [...(a.teamEmployeeIds ?? [])]); scopeSql = 'AND (e.branch_id = ANY($3::uuid[]) OR e.id = ANY($4::uuid[]))'; }
      const emps = (await c.query<{ id: string; branch_id: string | null }>(
        `SELECT e.id, e.branch_id FROM employees e WHERE e.tenant_id=$1 AND e.employment_status IN ('active','probation','on_notice') AND e.joined_at IS NOT NULL AND e.joined_at <= $2 ${scopeSql}`, params)).rows;
      if (emps.length === 0) return { created: 0, closed: 0, date: b.date };
      for (const e of emps) this.assertCan(a, 'attendance.mark', { id: e.id, branch_id: e.branch_id });
      const hol = (await c.query<{ branch_id: string | null }>(`SELECT branch_id FROM holidays WHERE tenant_id=$1 AND holiday_date=$2 AND NOT is_optional`, [a.tenantId, b.date])).rows;
      const dow = (await c.query<{ d: number }>(`SELECT extract(dow FROM $1::date)::int AS d`, [b.date])).rows[0]!.d;
      const existing = new Map((await c.query<{ employee_id: string; attendance_status: string; check_in_at: Date | null; check_out_at: Date | null; source: string }>(
        `SELECT employee_id, attendance_status, check_in_at, check_out_at, source FROM attendance_days WHERE tenant_id=$1 AND work_date=$2`, [a.tenantId, b.date])).rows.map((r) => [r.employee_id, r]));
      let created = 0; let closed = 0;
      for (const e of emps) {
        const cur = existing.get(e.id);
        if (cur) {
          if (cur.check_in_at && !cur.check_out_at && (cur.source === 'employee_checkin' || cur.source === 'device_import') && ['present', 'work_from_home'].includes(cur.attendance_status)) {
            await this.saveDay(c, a, { employeeId: e.id, workDate: b.date, checkIn: cur.check_in_at, checkOut: null, closed: true, source: cur.source });
            closed++;
          }
          continue;
        }
        const shift = await this.shiftFor(c, a.tenantId, e.id, b.date, tz);
        const isHoliday = hol.some((h) => h.branch_id === null || h.branch_id === e.branch_id);
        const isOff = (shift?.weeklyOffs ?? [0]).includes(dow);
        const status = isHoliday ? 'holiday' : isOff ? 'weekly_off' : 'absent';
        await this.saveDay(c, a, { employeeId: e.id, workDate: b.date, checkIn: null, checkOut: null, closed: true, source: 'system', status, approval: 'approved' });
        created++;
      }
      await this.audit.record(c, a, 'attendance.finalize', 'attendance_days', null, null, { date: b.date, created, closed });
      return { created, closed, date: b.date };
    });
  }

  // ---- payroll cut-off ------------------------------------------------------------------------------------------------
  async lock(a: RequestAuth, body: unknown): Promise<{ periodId: string; lockedAt: string }> {
    const b = lockAttendance.parse(body);
    return this.db.run(ctxOf(a, 'attendance locked'), async (c) => {
      const p = (await c.query<{ pay_group_id: string; start: string; end: string; locked: Date | null; status: string }>(
        `SELECT pay_group_id, to_char(period_start,'YYYY-MM-DD') AS start, to_char(period_end,'YYYY-MM-DD') AS "end", attendance_locked_at AS locked, status
           FROM payroll_periods WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, b.periodId])).rows[0];
      if (!p) throw notFound('payroll period');
      if (p.locked) throw new ApiError('invalid_state', 409, 'Attendance for this period is already locked');
      if (!['open', 'processing'].includes(p.status)) throw new ApiError('invalid_state', 409, `A ${p.status} period cannot be locked`);
      const today = await this.today(c, a.tenantId);
      if (p.end >= today) throw new ApiError('invalid_state', 409, 'Attendance can only be locked after the period has ended');
      const pend = (await c.query<{ days: number; corrections: number }>(
        `SELECT (SELECT count(*)::int FROM attendance_days d JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id
                  WHERE d.tenant_id=$1 AND e.pay_group_id=$2 AND d.work_date BETWEEN $3 AND $4 AND d.approval_status='pending') AS days,
                (SELECT count(*)::int FROM attendance_corrections k JOIN attendance_days d ON d.tenant_id=k.tenant_id AND d.id=k.attendance_day_id
                   JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id
                  WHERE k.tenant_id=$1 AND k.status='pending' AND e.pay_group_id=$2 AND d.work_date BETWEEN $3 AND $4) AS corrections`,
        [a.tenantId, p.pay_group_id, p.start, p.end])).rows[0]!;
      if (pend.days > 0 || pend.corrections > 0) {
        throw new ApiError('invalid_state', 409, `Resolve ${pend.days} day(s) awaiting review and ${pend.corrections} pending correction(s) before locking`);
      }
      const r = (await c.query<{ at: Date }>('UPDATE payroll_periods SET attendance_locked_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING attendance_locked_at AS at', [a.tenantId, b.periodId])).rows[0]!;
      await this.audit.record(c, a, 'attendance.lock', 'payroll_periods', b.periodId, null, { lockedAt: r.at.toISOString() });
      return { periodId: b.periodId, lockedAt: r.at.toISOString() };
    });
  }

  // ---- monthly summary --------------------------------------------------------------------------------------------------
  async summary(a: RequestAuth, query: unknown): Promise<AttendanceSummaryView> {
    const q = summaryQuery.parse(query);
    const empId = q.employeeId ?? a.employeeId;
    if (!empId) throw new ApiError('validation_failed', 422, 'No employee specified', [{ path: 'employeeId', message: 'required' }]);
    return this.db.run(ctxOf(a), async (c) => {
      const e = await this.loadEmployee(c, a, empId).catch(() => null);
      if (!e || !this.canView(a, e)) throw notFound('employee');
      const first = `${q.month}-01`;
      const r = (await c.query(
        `WITH m AS (SELECT $3::date AS s, (date_trunc('month', $3::date) + interval '1 month - 1 day')::date AS e),
              emp AS (SELECT GREATEST(COALESCE(joined_at, (SELECT s FROM m)), (SELECT s FROM m)) AS from_d FROM employees WHERE tenant_id=$1 AND id=$2),
              d AS (SELECT * FROM attendance_days WHERE tenant_id=$1 AND employee_id=$2 AND work_date BETWEEN (SELECT s FROM m) AND (SELECT e FROM m))
         SELECT count(*) FILTER (WHERE attendance_status='present')::int present, count(*) FILTER (WHERE attendance_status='half_day')::int half,
                count(*) FILTER (WHERE attendance_status='absent')::int absent, count(*) FILTER (WHERE attendance_status='leave')::int leave,
                count(*) FILTER (WHERE attendance_status='holiday')::int holiday, count(*) FILTER (WHERE attendance_status='weekly_off')::int off,
                count(*) FILTER (WHERE attendance_status='work_from_home')::int wfh, count(*) FILTER (WHERE attendance_status='not_marked')::int nm,
                count(*) FILTER (WHERE late_minutes > 0)::int late, COALESCE(sum(overtime_minutes),0)::int ot, COALESCE(sum(paid_day_fraction),0)::numeric AS paid,
                ((SELECT e FROM m) - (SELECT from_d FROM emp) + 1)::int AS span
           FROM d`, [a.tenantId, empId, first])).rows[0]!;
      const pol = await this.activePolicy(c, a.tenantId, first);
      const deduction = lateDeductionDays(r.late, pol?.row.lateMarksPerHalfDay);
      const paid = Math.max(0, Number(r.paid) - deduction);
      const unpaid = Math.max(0, r.span - paid);
      return {
        employeeId: empId, month: q.month, presentDays: r.present, halfDays: r.half, absentDays: r.absent, leaveDays: r.leave, holidays: r.holiday, weeklyOffs: r.off,
        workFromHomeDays: r.wfh, notMarked: r.nm, lateDays: r.late, lateMarkDeductionDays: deduction, overtimeMinutes: r.ot, paidDays: paid.toFixed(2), unpaidDays: unpaid.toFixed(2),
      };
    });
  }
}
