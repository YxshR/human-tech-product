import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { authorizeOnEmployee } from '@humantech/authz';
import {
  EXIT_TRANSITIONS, ExitView, TaskView, TemplateView, completeOnboarding, createTask, createTemplate, instantiateTasks, startExit, updateExit, updateTask, updateTemplate,
} from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { ApiError, forbidden, notFound } from '../common/errors';
import { employeeFor, tenantToday } from '../common/employee-access';

const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const TPL = `SELECT id, code, phase, title, description, owner_role_key, due_offset_days, required, active, display_order FROM onboarding_task_templates`;
const tplView = (r: Record<string, unknown>): TemplateView => ({
  id: r.id as string, code: r.code as string, phase: r.phase as string, title: r.title as string, description: (r.description as string | null) ?? null, ownerRoleKey: (r.owner_role_key as string | null) ?? null,
  dueOffsetDays: r.due_offset_days as number, required: r.required as boolean, active: r.active as boolean, displayOrder: r.display_order as number,
});
const TASK = `SELECT t.id, t.employee_id, e.branch_id, t.phase, t.title, t.owner_user_id, to_char(t.due_date,'YYYY-MM-DD') AS due_date, t.required, t.status, t.completed_by, t.completed_at, t.waiver_reason
  FROM onboarding_tasks t JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id`;
const taskView = (r: Record<string, unknown>): TaskView => ({
  id: r.id as string, employeeId: r.employee_id as string, phase: r.phase as string, title: r.title as string, ownerUserId: (r.owner_user_id as string | null) ?? null, dueDate: (r.due_date as string | null) ?? null,
  required: r.required as boolean, status: r.status as string, completedBy: (r.completed_by as string | null) ?? null, completedAt: iso(r.completed_at as Date | null), waiverReason: (r.waiver_reason as string | null) ?? null,
});
const EXIT = `SELECT id, employee_id, status, to_char(resignation_date,'YYYY-MM-DD') AS resignation_date, to_char(last_working_date,'YYYY-MM-DD') AS last_working_date, reason_code, reason_notes,
  access_revoked_at, final_settlement_status, initiated_by FROM employee_exits`;
const exitView = (r: Record<string, unknown>): ExitView => ({
  id: r.id as string, employeeId: r.employee_id as string, status: r.status as string, resignationDate: (r.resignation_date as string | null) ?? null, lastWorkingDate: r.last_working_date as string,
  reasonCode: (r.reason_code as string | null) ?? null, reasonNotes: (r.reason_notes as string | null) ?? null, accessRevokedAt: iso(r.access_revoked_at as Date | null),
  finalSettlementStatus: r.final_settlement_status as string, initiatedBy: (r.initiated_by as string | null) ?? null,
});

@Injectable()
export class OnboardingService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  // ---- templates -----------------------------------------------------------------------------------------------------
  async listTemplates(a: RequestAuth): Promise<TemplateView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(`${TPL} WHERE tenant_id=$1 ORDER BY phase, display_order, code`, [a.tenantId])).rows.map(tplView));
  }
  async createTemplate(a: RequestAuth, body: unknown): Promise<TemplateView> {
    const b = createTemplate.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(
        `INSERT INTO onboarding_task_templates (tenant_id, code, phase, title, description, owner_role_key, due_offset_days, required, display_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, code, phase, title, description, owner_role_key, due_offset_days, required, active, display_order`,
        [a.tenantId, b.code, b.phase, b.title, b.description ?? null, b.ownerRoleKey ?? null, b.dueOffsetDays, b.required, b.displayOrder])).rows[0]!;
      await this.audit.record(c, a, 'onboarding_template.create', 'onboarding_task_templates', r.id, null, { code: b.code, phase: b.phase });
      return tplView(r);
    });
  }
  async updateTemplate(a: RequestAuth, id: string, body: unknown): Promise<TemplateView> {
    const b = updateTemplate.parse(body);
    if (!Object.keys(b).length) throw new ApiError('validation_failed', 422, 'Nothing to update');
    return this.db.run(ctxOf(a), async (c) => {
      const has = (k: keyof typeof b) => b[k] !== undefined;
      const r = (await c.query(
        `UPDATE onboarding_task_templates SET title=COALESCE($3,title), description=CASE WHEN $4::boolean THEN $5 ELSE description END, owner_role_key=CASE WHEN $6::boolean THEN $7 ELSE owner_role_key END,
            due_offset_days=COALESCE($8,due_offset_days), required=COALESCE($9,required), display_order=COALESCE($10,display_order), active=COALESCE($11,active)
          WHERE tenant_id=$1 AND id=$2 RETURNING id, code, phase, title, description, owner_role_key, due_offset_days, required, active, display_order`,
        [a.tenantId, id, b.title ?? null, has('description'), b.description ?? null, has('ownerRoleKey'), b.ownerRoleKey ?? null, b.dueOffsetDays ?? null, b.required ?? null, b.displayOrder ?? null, b.active ?? null])).rows[0];
      if (!r) throw notFound('template');
      await this.audit.record(c, a, 'onboarding_template.update', 'onboarding_task_templates', id, null, { fields: Object.keys(b) });
      return tplView(r);
    });
  }

  // ---- tasks -----------------------------------------------------------------------------------------------------------
  async listTasks(a: RequestAuth, employeeId: string): Promise<TaskView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'onboarding.read', { allowOwn: 'profile.read_own' });
      return (await c.query(`${TASK} WHERE t.tenant_id=$1 AND t.employee_id=$2 ORDER BY t.phase, t.due_date NULLS LAST, t.created_at`, [a.tenantId, employeeId])).rows.map(taskView);
    });
  }
  async myTasks(a: RequestAuth): Promise<TaskView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(`${TASK} WHERE t.tenant_id=$1 AND t.status IN ('pending','in_progress') AND (t.owner_user_id=$2 OR ($3::uuid IS NOT NULL AND t.employee_id=$3)) ORDER BY t.due_date NULLS LAST LIMIT 200`, [a.tenantId, a.userId, a.employeeId ?? null])).rows.map(taskView));
  }
  private async instantiateIn(c: PoolClient, a: RequestAuth, employeeId: string, phase: 'onboarding' | 'offboarding', anchor: string): Promise<number> {
    const r = await c.query(
      `INSERT INTO onboarding_tasks (tenant_id, employee_id, template_id, phase, title, due_date, required)
       SELECT t.tenant_id, $2, t.id, t.phase, t.title, $4::date + t.due_offset_days, t.required FROM onboarding_task_templates t
        WHERE t.tenant_id=$1 AND t.phase=$3 AND t.active AND NOT EXISTS (SELECT 1 FROM onboarding_tasks x WHERE x.tenant_id=t.tenant_id AND x.employee_id=$2 AND x.template_id=t.id)
        ORDER BY t.display_order, t.code`, [a.tenantId, employeeId, phase, anchor]);
    return r.rowCount ?? 0;
  }
  async instantiate(a: RequestAuth, employeeId: string, body: unknown): Promise<TaskView[]> {
    const b = instantiateTasks.parse(body ?? {});
    return this.db.run(ctxOf(a), async (c) => {
      const e = await employeeFor(c, a, employeeId, 'onboarding.manage');
      let anchor = b.anchorDate ?? null;
      if (!anchor && b.phase === 'onboarding') anchor = e.joined_at;
      if (!anchor && b.phase === 'offboarding') anchor = (await c.query<{ d: string | null }>(`SELECT to_char(last_working_date,'YYYY-MM-DD') AS d FROM employees WHERE tenant_id=$1 AND id=$2`, [a.tenantId, employeeId])).rows[0]!.d;
      anchor ??= await tenantToday(c, a.tenantId);
      const n = await this.instantiateIn(c, a, employeeId, b.phase, anchor);
      await this.audit.record(c, a, 'onboarding.instantiate', 'employees', employeeId, null, { phase: b.phase, created: n });
      return (await c.query(`${TASK} WHERE t.tenant_id=$1 AND t.employee_id=$2 AND t.phase=$3 ORDER BY t.due_date NULLS LAST, t.created_at`, [a.tenantId, employeeId, b.phase])).rows.map(taskView);
    });
  }
  async addTask(a: RequestAuth, employeeId: string, body: unknown): Promise<TaskView> {
    const b = createTask.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'onboarding.manage');
      const r = (await c.query<{ id: string }>('INSERT INTO onboarding_tasks (tenant_id, employee_id, phase, title, due_date, required) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [a.tenantId, employeeId, b.phase, b.title, b.dueDate ?? null, b.required])).rows[0]!;
      await this.audit.record(c, a, 'onboarding.task_add', 'onboarding_tasks', r.id, null, { employeeId });
      return taskView((await c.query(`${TASK} WHERE t.tenant_id=$1 AND t.id=$2`, [a.tenantId, r.id])).rows[0]!);
    });
  }
  async updateTask(a: RequestAuth, taskId: string, body: unknown): Promise<TaskView> {
    const b = updateTask.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const t = (await c.query(`${TASK} WHERE t.tenant_id=$1 AND t.id=$2 FOR UPDATE OF t`, [a.tenantId, taskId])).rows[0];
      if (!t) throw notFound('task');
      const manage = authorizeOnEmployee(a, 'onboarding.manage', { tenantId: a.tenantId, branchId: t.branch_id, employeeId: t.employee_id });
      const isOwner = t.owner_user_id === a.userId;
      if (!manage.allowed && !isOwner) throw notFound('task');
      if (b.ownerUserId !== undefined && !manage.allowed) throw forbidden('Only onboarding managers can reassign tasks');
      if (b.status === 'waived') {
        if (!manage.allowed) throw forbidden('Only onboarding managers can waive tasks');
        if (!b.waiverReason) throw new ApiError('validation_failed', 422, 'A reason is required to waive a task', [{ path: 'waiverReason', message: 'required' }]);
      }
      if (b.ownerUserId) {
        const m = await c.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'`, [a.tenantId, b.ownerUserId]);
        if (!m.rowCount) throw new ApiError('validation_failed', 422, 'The owner must be an active member of the company', [{ path: 'ownerUserId', message: 'not a member' }]);
      }
      const done = b.status === 'done' || b.status === 'waived';
      await c.query(
        `UPDATE onboarding_tasks SET status=$3, waiver_reason=CASE WHEN $3='waived' THEN $4 ELSE NULL END, completed_by=CASE WHEN $5::boolean THEN $6::uuid ELSE NULL END,
            completed_at=CASE WHEN $5::boolean THEN now() ELSE NULL END, owner_user_id=CASE WHEN $7::boolean THEN $8::uuid ELSE owner_user_id END WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, taskId, b.status, b.waiverReason ?? null, done, a.userId, b.ownerUserId !== undefined, b.ownerUserId ?? null]);
      await this.audit.record(c, a, 'onboarding.task_update', 'onboarding_tasks', taskId, { status: t.status }, { status: b.status });
      return taskView((await c.query(`${TASK} WHERE t.tenant_id=$1 AND t.id=$2`, [a.tenantId, taskId])).rows[0]!);
    });
  }

  /** Moves a new hire from onboarding to active/probation once every required task is done or waived. */
  async completeOnboarding(a: RequestAuth, employeeId: string, body: unknown): Promise<{ employeeId: string; employmentStatus: string }> {
    const b = completeOnboarding.parse(body ?? {});
    return this.db.run(ctxOf(a, 'onboarding completed'), async (c) => {
      const e = await employeeFor(c, a, employeeId, 'onboarding.manage', {}, true);
      if (e.employment_status !== 'onboarding') throw new ApiError('invalid_state', 409, `An employee who is ${e.employment_status} is not in onboarding`);
      if (!e.joined_at) throw new ApiError('validation_failed', 422, 'Set the joining date first', [{ path: 'joinedAt', message: 'required' }]);
      const open = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM onboarding_tasks WHERE tenant_id=$1 AND employee_id=$2 AND phase='onboarding' AND required AND status NOT IN ('done','waived')`, [a.tenantId, employeeId])).rows[0]!.n;
      if (open) throw new ApiError('invalid_state', 409, `${open} required onboarding task(s) are still open`);
      await c.query('UPDATE employees SET employment_status=$3 WHERE tenant_id=$1 AND id=$2', [a.tenantId, employeeId, b.employmentStatus]);
      await this.audit.record(c, a, 'onboarding.complete', 'employees', employeeId, { status: 'onboarding' }, { status: b.employmentStatus });
      return { employeeId, employmentStatus: b.employmentStatus };
    });
  }

  // ---- exits ---------------------------------------------------------------------------------------------------------------
  async getExit(a: RequestAuth, employeeId: string): Promise<ExitView | null> {
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'employee.exit', { allowOwn: 'profile.read_own' });
      const r = (await c.query(`${EXIT} WHERE tenant_id=$1 AND employee_id=$2 AND status<>'cancelled' ORDER BY created_at DESC LIMIT 1`, [a.tenantId, employeeId])).rows[0];
      return r ? exitView(r) : null;
    });
  }
  async startExit(a: RequestAuth, employeeId: string, body: unknown): Promise<ExitView> {
    const b = startExit.parse(body);
    return this.db.run(ctxOf(a, 'exit initiated'), async (c) => {
      const e = await employeeFor(c, a, employeeId, 'employee.exit', {}, true);
      if (!['active', 'probation', 'on_notice'].includes(e.employment_status)) throw new ApiError('invalid_state', 409, `An employee who is ${e.employment_status} cannot be offboarded`);
      if (e.joined_at && b.lastWorkingDate < e.joined_at) throw new ApiError('validation_failed', 422, 'The last working day cannot be before the joining date', [{ path: 'lastWorkingDate', message: 'before joining date' }]);
      const r = (await c.query<{ id: string }>(
        `INSERT INTO employee_exits (tenant_id, employee_id, resignation_date, last_working_date, reason_code, reason_notes, initiated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [a.tenantId, employeeId, b.resignationDate ?? null, b.lastWorkingDate, b.reasonCode ?? null, b.reasonNotes ?? null, a.userId]).catch((err) => {
        if ((err as { code?: string }).code === '23505') throw new ApiError('conflict', 409, 'An exit is already in progress for this employee');
        throw err;
      })).rows[0]!;
      await c.query(`UPDATE employees SET employment_status='on_notice', last_working_date=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, employeeId, b.lastWorkingDate]);
      if (b.createTasks) await this.instantiateIn(c, a, employeeId, 'offboarding', b.lastWorkingDate);
      await this.audit.record(c, a, 'exit.start', 'employee_exits', r.id, null, { employeeId, lastWorkingDate: b.lastWorkingDate });
      return exitView((await c.query(`${EXIT} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, r.id])).rows[0]!);
    });
  }
  async updateExit(a: RequestAuth, exitId: string, body: unknown): Promise<ExitView> {
    const b = updateExit.parse(body);
    return this.db.run(ctxOf(a, 'exit updated'), async (c) => {
      const x = (await c.query(`${EXIT} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, exitId])).rows[0];
      if (!x) throw notFound('exit');
      const emp = await employeeFor(c, a, x.employee_id, 'employee.exit', {}, true);
      if (['completed', 'cancelled'].includes(x.status)) throw new ApiError('invalid_state', 409, `An exit that is ${x.status} cannot change`);
      let status = x.status as string;
      if (b.status && b.status !== status) {
        if (!EXIT_TRANSITIONS[status]?.includes(b.status)) throw new ApiError('invalid_state', 409, `An exit cannot move from ${status} to ${b.status}`);
        status = b.status;
      }
      const lwd = b.lastWorkingDate ?? x.last_working_date;
      if (emp.joined_at && lwd < emp.joined_at) throw new ApiError('validation_failed', 422, 'The last working day cannot be before the joining date', [{ path: 'lastWorkingDate', message: 'before joining date' }]);
      let revoke = false;
      if (status === 'completed') {
        const open = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM onboarding_tasks WHERE tenant_id=$1 AND employee_id=$2 AND phase='offboarding' AND required AND status NOT IN ('done','waived')`, [a.tenantId, x.employee_id])).rows[0]!.n;
        if (open) throw new ApiError('invalid_state', 409, `${open} required offboarding task(s) are still open`);
        const settle = b.finalSettlementStatus ?? x.final_settlement_status;
        if (settle === 'not_started' || settle === 'in_progress') throw new ApiError('invalid_state', 409, 'Record the final settlement as paid or not applicable before completing the exit');
        revoke = b.revokeAccess !== false;
      }
      await c.query(
        `UPDATE employee_exits SET status=$3, last_working_date=$4, reason_notes=COALESCE($5,reason_notes), final_settlement_status=COALESCE($6,final_settlement_status) WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, exitId, status, lwd, b.reasonNotes ?? null, b.finalSettlementStatus ?? null]);
      if (status === 'completed') {
        await c.query(`UPDATE employees SET employment_status='exited', exited_at=$3, last_working_date=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, x.employee_id, lwd]);
        if (revoke && emp.user_id) {
          await c.query(`UPDATE tenant_memberships SET status='suspended', revoked_at=now() WHERE tenant_id=$1 AND user_id=$2`, [a.tenantId, emp.user_id]);
          await c.query(`UPDATE user_sessions SET revoked_at=now(), revoked_reason='employee exited' WHERE user_id=$1 AND revoked_at IS NULL`, [emp.user_id]).catch(() => undefined);
          await c.query('UPDATE employee_exits SET access_revoked_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, exitId]);
        }
      } else if (status === 'cancelled') {
        await c.query(`UPDATE employees SET employment_status='active', last_working_date=NULL WHERE tenant_id=$1 AND id=$2`, [a.tenantId, x.employee_id]);
      } else if (b.lastWorkingDate) {
        await c.query('UPDATE employees SET last_working_date=$3 WHERE tenant_id=$1 AND id=$2', [a.tenantId, x.employee_id, lwd]);
      }
      await this.audit.record(c, a, 'exit.update', 'employee_exits', exitId, { status: x.status }, { status, lastWorkingDate: lwd });
      return exitView((await c.query(`${EXIT} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, exitId])).rows[0]!);
    });
  }
}
