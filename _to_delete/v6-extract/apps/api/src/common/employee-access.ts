import type { PoolClient } from 'pg';
import { PermissionKey, authorizeOnEmployee } from '@humantech/authz';
import { RequestAuth } from '../auth/auth-context';
import { forbidden, notFound } from './errors';

export interface EmployeeRef { id: string; branch_id: string | null; user_id: string | null; employment_status: string; joined_at: string | null }

/** Loads an employee the caller may act on with `perm` (own record via `allowOwn`). Out of scope reads as 404, missing permission as 403. */
export async function employeeFor(c: PoolClient, a: RequestAuth, id: string, perm: PermissionKey, opts: { allowOwn?: PermissionKey; allowTeam?: boolean } = {}, lock = false): Promise<EmployeeRef> {
  const e = (await c.query<EmployeeRef>(
    `SELECT id, branch_id, user_id, employment_status, to_char(joined_at,'YYYY-MM-DD') AS joined_at FROM employees WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [a.tenantId, id])).rows[0];
  if (!e) throw notFound('employee');
  const d = authorizeOnEmployee(a, perm, { tenantId: a.tenantId, branchId: e.branch_id, employeeId: e.id }, opts);
  if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
  return e;
}

/** "Today" in the company's time zone (default Asia/Kolkata). */
export async function tenantToday(c: PoolClient, tenantId: string): Promise<string> {
  return (await c.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE timezone)::date,'YYYY-MM-DD') AS d FROM tenants WHERE id=$1`, [tenantId])).rows[0]!.d;
}
