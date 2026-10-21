import { Inject, Injectable } from '@nestjs/common';
import {
  BranchView, HolidayView, OrgItemView, OrgResource, createBranch, createHoliday, createOrgItem, holidayQuery, updateBranch, updateOrgItem,
} from '@humantech/contracts';
import { z } from 'zod';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { ApiError, notFound } from '../common/errors';
import { setClause } from '../common/sql';

const TABLE: Record<OrgResource, { table: string; fk: string; noun: string }> = {
  departments: { table: 'departments', fk: 'department_id', noun: 'department' },
  designations: { table: 'designations', fk: 'designation_id', noun: 'designation' },
  'cost-centres': { table: 'cost_centres', fk: 'cost_centre_id', noun: 'cost centre' },
};
const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });

@Injectable()
export class OrgService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  private async assertNoActiveStaff(c: import('pg').PoolClient, tenantId: string, fk: string, id: string, noun: string): Promise<void> {
    const n = await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM employees WHERE tenant_id=$1 AND ${fk}=$2 AND employment_status NOT IN ('exited','archived')`, [tenantId, id]);
    if (n.rows[0]!.n > 0) throw new ApiError('conflict', 409, `This ${noun} still has ${n.rows[0]!.n} active employee(s); move them first`);
  }

  // ---- departments / designations / cost centres -------------------------------------------
  async listItems(a: RequestAuth, r: OrgResource, includeArchived: boolean): Promise<OrgItemView[]> {
    const t = TABLE[r];
    return this.db.run(ctxOf(a), async (c) =>
      (await c.query<OrgItemView>(
        `SELECT id, code, name, status FROM ${t.table} WHERE tenant_id=$1 ${includeArchived ? '' : "AND status <> 'archived'"} ORDER BY code`, [a.tenantId])).rows);
  }
  async createItem(a: RequestAuth, r: OrgResource, body: unknown): Promise<OrgItemView> {
    const b = createOrgItem.parse(body);
    const t = TABLE[r];
    return this.db.run(ctxOf(a), async (c) => {
      const row = (await c.query<OrgItemView>(`INSERT INTO ${t.table} (tenant_id, code, name) VALUES ($1,$2,$3) RETURNING id, code, name, status`, [a.tenantId, b.code, b.name])).rows[0]!;
      await this.audit.record(c, a, `${t.noun.replace(' ', '_')}.create`, t.table, row.id, null, { code: row.code, name: row.name });
      return row;
    });
  }
  async updateItem(a: RequestAuth, r: OrgResource, id: string, body: unknown): Promise<OrgItemView> {
    const b = updateOrgItem.parse(body);
    if (Object.keys(b).length === 0) throw new ApiError('validation_failed', 422, 'Nothing to update');
    const t = TABLE[r];
    return this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query<OrgItemView>(`SELECT id, code, name, status FROM ${t.table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound(t.noun);
      if (b.status && b.status !== 'active' && cur.status === 'active') await this.assertNoActiveStaff(c, a.tenantId, t.fk, id, t.noun);
      const s = setClause({ name: b.name, status: b.status }, 3);
      const row = (await c.query<OrgItemView>(`UPDATE ${t.table} SET ${s.sql} WHERE tenant_id=$1 AND id=$2 RETURNING id, code, name, status`, [a.tenantId, id, ...s.params])).rows[0]!;
      await this.audit.record(c, a, `${t.noun.replace(' ', '_')}.update`, t.table, id, { name: cur.name, status: cur.status }, { name: row.name, status: row.status });
      return row;
    });
  }

  // ---- branches -----------------------------------------------------------------------------
  private branchView = (r: { id: string; code: string; name: string; status: string; state_code: string | null; timezone: string | null; address: Record<string, unknown> }): BranchView =>
    ({ id: r.id, code: r.code, name: r.name, status: r.status, stateCode: r.state_code, timezone: r.timezone, address: r.address });

  async listBranches(a: RequestAuth, includeArchived: boolean): Promise<BranchView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const params: unknown[] = [a.tenantId];
      let scope = '';
      if (a.branchScope.mode === 'listed') { params.push([...a.branchScope.branchIds]); scope = 'AND id = ANY($2::uuid[])'; }
      const rows = (await c.query(`SELECT id, code, name, status, state_code, timezone, address FROM branches
        WHERE tenant_id=$1 ${scope} ${includeArchived ? '' : "AND status <> 'archived'"} ORDER BY code`, params)).rows;
      return rows.map(this.branchView);
    });
  }
  async createBranch(a: RequestAuth, body: unknown): Promise<BranchView> {
    const b = createBranch.parse(body);
    if (a.branchScope.mode === 'listed') throw new ApiError('forbidden', 403, 'Only users with company-wide scope can create branches');
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(`INSERT INTO branches (tenant_id, code, name, state_code, timezone, address) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, code, name, status, state_code, timezone, address`, [a.tenantId, b.code, b.name, b.state_code ?? null, b.timezone ?? null, JSON.stringify(b.address ?? {})])).rows[0];
      await this.audit.record(c, a, 'branch.create', 'branches', r.id, null, { code: r.code, name: r.name });
      return this.branchView(r);
    });
  }
  async updateBranch(a: RequestAuth, id: string, body: unknown): Promise<BranchView> {
    const b = updateBranch.parse(body);
    if (Object.keys(b).length === 0) throw new ApiError('validation_failed', 422, 'Nothing to update');
    if (a.branchScope.mode === 'listed' && !a.branchScope.branchIds.has(id)) throw notFound('branch');
    return this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query(`SELECT id, code, name, status, state_code, timezone, address FROM branches WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('branch');
      if (b.status && b.status !== 'active' && cur.status === 'active') await this.assertNoActiveStaff(c, a.tenantId, 'branch_id', id, 'branch');
      const s = setClause({ name: b.name, state_code: b.state_code, timezone: b.timezone, address: b.address, status: b.status }, 3);
      const r = (await c.query(`UPDATE branches SET ${s.sql} WHERE tenant_id=$1 AND id=$2 RETURNING id, code, name, status, state_code, timezone, address`, [a.tenantId, id, ...s.params])).rows[0];
      await this.audit.record(c, a, 'branch.update', 'branches', id, { name: cur.name, status: cur.status }, { name: r.name, status: r.status });
      return this.branchView(r);
    });
  }

  // ---- holidays -----------------------------------------------------------------------------
  private holidayView = (r: { id: string; holiday_date: string; name: string; is_optional: boolean; branch_id: string | null }): HolidayView =>
    ({ id: r.id, holidayDate: r.holiday_date, name: r.name, isOptional: r.is_optional, branchId: r.branch_id });

  async listHolidays(a: RequestAuth, q: z.infer<typeof holidayQuery>): Promise<HolidayView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const params: unknown[] = [a.tenantId];
      const w: string[] = ['tenant_id=$1'];
      if (q.year) { params.push(`${q.year}-01-01`, `${q.year}-12-31`); w.push(`holiday_date BETWEEN $${params.length - 1} AND $${params.length}`); }
      if (q.branchId) { params.push(q.branchId); w.push(`(branch_id IS NULL OR branch_id=$${params.length})`); }
      if (a.branchScope.mode === 'listed') { params.push([...a.branchScope.branchIds]); w.push(`(branch_id IS NULL OR branch_id = ANY($${params.length}::uuid[]))`); }
      return (await c.query(`SELECT id, to_char(holiday_date,'YYYY-MM-DD') holiday_date, name, is_optional, branch_id FROM holidays WHERE ${w.join(' AND ')} ORDER BY holiday_date, name`, params)).rows.map(this.holidayView);
    });
  }
  async createHoliday(a: RequestAuth, body: unknown): Promise<HolidayView> {
    const b = createHoliday.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(`INSERT INTO holidays (tenant_id, holiday_date, name, is_optional, branch_id) VALUES ($1,$2,$3,$4,$5)
        RETURNING id, to_char(holiday_date,'YYYY-MM-DD') holiday_date, name, is_optional, branch_id`, [a.tenantId, b.holidayDate, b.name, b.isOptional, b.branchId ?? null])).rows[0];
      await this.audit.record(c, a, 'holiday.create', 'holidays', r.id, null, { date: r.holiday_date, name: r.name });
      return this.holidayView(r);
    });
  }
  async deleteHoliday(a: RequestAuth, id: string): Promise<void> {
    await this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(`DELETE FROM holidays WHERE tenant_id=$1 AND id=$2 RETURNING to_char(holiday_date,'YYYY-MM-DD') d, name`, [a.tenantId, id])).rows[0];
      if (!r) throw notFound('holiday');
      await this.audit.record(c, a, 'holiday.delete', 'holidays', id, { date: r.d, name: r.name }, null);
    });
  }
}
