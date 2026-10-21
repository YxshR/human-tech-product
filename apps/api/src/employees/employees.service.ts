import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { CreateEmployee, EmployeeView, UpdateEmployee, decodeCursor, encodeCursor } from '@humantech/contracts';
import { authorizeOnEmployee, hasPermission, inBranchScope, redact } from '@humantech/authz';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { ApiError, forbidden, notFound } from '../common/errors';

const COLS = `e.id, e.employee_number, e.first_name, e.last_name, e.work_email, e.personal_email, e.phone,
  e.employment_status, e.employment_type, e.branch_id, e.department_id, e.manager_id, e.user_id,
  to_char(e.joined_at,'YYYY-MM-DD') AS joined_at, e.version`;

interface Row {
  id: string; employee_number: string; first_name: string; last_name: string | null; work_email: string | null;
  personal_email: string | null; phone: string | null; employment_status: EmployeeView['employmentStatus'];
  employment_type: EmployeeView['employmentType']; branch_id: string | null; department_id: string | null;
  manager_id: string | null; user_id: string | null; joined_at: string | null; version: number;
}

const SENSITIVE_UPDATE = new Set<keyof UpdateEmployee>(['personalEmail', 'phone']);
const COLUMN: Record<string, string> = {
  firstName: 'first_name', middleName: 'middle_name', lastName: 'last_name', workEmail: 'work_email',
  personalEmail: 'personal_email', phone: 'phone', branchId: 'branch_id', departmentId: 'department_id',
  designationId: 'designation_id', managerId: 'manager_id', employmentType: 'employment_type', joinedAt: 'joined_at',
};

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

@Injectable()
export class EmployeesService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private view(auth: RequestAuth, r: Row): EmployeeView {
    const own = r.user_id !== null && r.user_id === auth.userId;
    const shaped = redact(auth, 'employee', { personal_email: r.personal_email, phone: r.phone }, { isOwnRecord: own });
    return {
      id: r.id, employeeNumber: r.employee_number, firstName: r.first_name, lastName: r.last_name, workEmail: r.work_email,
      employmentStatus: r.employment_status, employmentType: r.employment_type, branchId: r.branch_id,
      departmentId: r.department_id, managerId: r.manager_id, joinedAt: r.joined_at, version: r.version,
      ...('phone' in shaped ? { phone: r.phone } : {}),
      ...('personal_email' in shaped ? { personalEmail: r.personal_email } : {}),
    };
  }

  private async audit(c: PoolClient, auth: RequestAuth, action: string, id: string, before: unknown, after: unknown): Promise<void> {
    await c.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, before_redacted, after_redacted, request_id, source)
       VALUES ($1,$2,$3,'employees',$4,$5,$6,$7,'api')`,
      [auth.tenantId, auth.userId, action, id, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), auth.requestId],
    );
  }

  async list(auth: RequestAuth, q: { q?: string; status?: string; branchId?: string; cursor?: string; limit: number }): Promise<{ data: EmployeeView[]; nextCursor: string | null }> {
    const params: unknown[] = [auth.tenantId];
    const where: string[] = ['e.tenant_id = $1'];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };

    if (auth.branchScope.mode === 'listed') {
      const branches = add([...auth.branchScope.branchIds]);
      const team = add([...(auth.teamEmployeeIds ?? [])]);
      where.push(`(e.branch_id = ANY(${branches}::uuid[]) OR e.id = ANY(${team}::uuid[]))`);
    }
    if (q.status) where.push(`e.employment_status = ${add(q.status)}`);
    if (q.branchId) where.push(`e.branch_id = ${add(q.branchId)}`);
    if (q.q) {
      const p = add(like(q.q));
      where.push(`(e.first_name ILIKE ${p} OR e.last_name ILIKE ${p} OR e.employee_number ILIKE ${p} OR e.work_email ILIKE ${p})`);
    }
    if (q.cursor) {
      let key: Array<string | number>;
      try { key = decodeCursor(q.cursor); } catch { throw new ApiError('validation_failed', 422, 'Invalid cursor', [{ path: 'cursor', message: 'invalid cursor' }]); }
      if (typeof key[0] !== 'string') throw new ApiError('validation_failed', 422, 'Invalid cursor', [{ path: 'cursor', message: 'invalid cursor' }]);
      where.push(`e.employee_number > ${add(key[0])}`);
    }
    const limit = add(q.limit + 1);
    const rows = await this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (c) =>
      (await c.query<Row>(`SELECT ${COLS} FROM employees e WHERE ${where.join(' AND ')} ORDER BY e.employee_number LIMIT ${limit}`, params)).rows);
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((r) => this.view(auth, r)),
      nextCursor: rows.length > q.limit ? encodeCursor([page[page.length - 1]!.employee_number]) : null,
    };
  }

  async get(auth: RequestAuth, id: string): Promise<EmployeeView> {
    const r = await this.db.run({ tenantId: auth.tenantId, userId: auth.userId }, async (c) =>
      (await c.query<Row>(`SELECT ${COLS} FROM employees e WHERE e.tenant_id=$1 AND e.id=$2`, [auth.tenantId, id])).rows[0]);
    if (!r) throw notFound('employee');
    this.assertReadable(auth, r);
    return this.view(auth, r);
  }

  /** Own record via profile.read_own; otherwise employee.read within branch/team scope. */
  assertReadable(auth: RequestAuth, r: Pick<Row, 'id' | 'branch_id'>): void {
    const d = authorizeOnEmployee(auth, 'employee.read', { tenantId: auth.tenantId, branchId: r.branch_id, employeeId: r.id },
      { allowOwn: 'profile.read_own', allowTeam: true });
    if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
  }

  async create(auth: RequestAuth, body: CreateEmployee): Promise<EmployeeView> {
    const scope = inBranchScope(auth, { tenantId: auth.tenantId, branchId: body.branchId });
    if (!scope.allowed) throw notFound('branch');
    if ((body.personalEmail || body.phone) && !hasPermission(auth, 'employee.update_sensitive')) throw forbidden('You cannot set personal contact details');
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId, reason: 'employee created' }, async (c) => {
      const num = (await c.query<{ n: string }>('SELECT app.next_employee_number() AS n')).rows[0]!.n;
      const r = (await c.query<Row>(
        `INSERT INTO employees AS e (tenant_id, employee_number, first_name, middle_name, last_name, work_email, personal_email, phone,
                                  branch_id, department_id, designation_id, manager_id, employment_type, joined_at, created_by, employment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'onboarding')
         RETURNING ${COLS}`,
        [auth.tenantId, num, body.firstName, body.middleName ?? null, body.lastName ?? null, body.workEmail ?? null, body.personalEmail ?? null,
          body.phone ?? null, body.branchId, body.departmentId ?? null, body.designationId ?? null, body.managerId ?? null,
          body.employmentType, body.joinedAt ?? null, auth.userId])).rows[0]!;
      await this.audit(c, auth, 'employee.create', r.id, null, { employeeNumber: r.employee_number, branchId: r.branch_id });
      return this.view(auth, r);
    });
  }

  async update(auth: RequestAuth, id: string, body: UpdateEmployee): Promise<EmployeeView> {
    const { version, ...changes } = body;
    const keys = Object.keys(changes) as Array<keyof typeof changes>;
    if (keys.length === 0) throw new ApiError('validation_failed', 422, 'Nothing to update');
    if (keys.some((k) => SENSITIVE_UPDATE.has(k)) && !hasPermission(auth, 'employee.update_sensitive')) throw forbidden('You cannot change personal contact details');

    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId, reason: 'employee updated' }, async (c) => {
      const cur = (await c.query<Row>(`SELECT ${COLS} FROM employees e WHERE e.tenant_id=$1 AND e.id=$2 FOR UPDATE`, [auth.tenantId, id])).rows[0];
      if (!cur) throw notFound('employee');
      const d = authorizeOnEmployee(auth, 'employee.update', { tenantId: auth.tenantId, branchId: cur.branch_id, employeeId: cur.id });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
      if (changes.branchId) {
        const to = inBranchScope(auth, { tenantId: auth.tenantId, branchId: changes.branchId });
        if (!to.allowed) throw notFound('branch');
      }
      if (cur.version !== version) throw new ApiError('version_conflict', 409, 'This record was changed by someone else; reload and try again');

      const sets: string[] = [];
      const params: unknown[] = [auth.tenantId, id];
      for (const k of keys) {
        params.push(changes[k] ?? null);
        sets.push(`${COLUMN[k as string]} = $${params.length}`);
      }
      const r = (await c.query<Row>(
        `UPDATE employees e SET ${sets.join(', ')} WHERE e.tenant_id=$1 AND e.id=$2 RETURNING ${COLS}`, params)).rows[0]!;
      const redactKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SENSITIVE_UPDATE.has(k as keyof UpdateEmployee) ? '[redacted]' : v]));
      const before = Object.fromEntries(keys.map((k) => [k, (cur as unknown as Record<string, unknown>)[COLUMN[k as string]!]]));
      await this.audit(c, auth, 'employee.update', id, redactKeys(before), redactKeys(changes));
      return this.view(auth, r);
    });
  }

  async archive(auth: RequestAuth, id: string): Promise<EmployeeView> {
    return this.db.run({ tenantId: auth.tenantId, userId: auth.userId, reason: 'employee archived' }, async (c) => {
      const cur = (await c.query<Row>(`SELECT ${COLS} FROM employees e WHERE e.tenant_id=$1 AND e.id=$2 FOR UPDATE`, [auth.tenantId, id])).rows[0];
      if (!cur) throw notFound('employee');
      const d = authorizeOnEmployee(auth, 'employee.archive', { tenantId: auth.tenantId, branchId: cur.branch_id, employeeId: cur.id });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
      if (cur.employment_status === 'archived') return this.view(auth, cur);
      const r = (await c.query<Row>(
        `UPDATE employees e SET employment_status='archived', archived_at=now() WHERE e.tenant_id=$1 AND e.id=$2 RETURNING ${COLS}`, [auth.tenantId, id])).rows[0]!;
      await this.audit(c, auth, 'employee.archive', id, { status: cur.employment_status }, { status: 'archived' });
      return this.view(auth, r);
    });
  }
}
