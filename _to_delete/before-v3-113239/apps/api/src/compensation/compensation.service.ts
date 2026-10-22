import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { authorizeOnEmployee } from '@humantech/authz';
import {
  AssignmentView, ComponentVersionView, ComponentView, StructureView, createComponent, createComponentVersion, createStructure, proposeAssignment,
  reviewAssignment, updateComponent, updateStructure,
} from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { ApiError, forbidden, notFound } from '../common/errors';

const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const VERSION_COLS = `id, component_id, version, calculation_method, base_component_codes, default_amount::text, default_percentage::text, rounding_mode, rounding_places,
  is_taxable, prorate_on_unpaid_days, statutory_group, configuration, to_char(effective_from,'YYYY-MM-DD') AS effective_from, to_char(effective_to,'YYYY-MM-DD') AS effective_to, status`;
const versionView = (r: Record<string, unknown>): ComponentVersionView => ({
  id: r.id as string, version: r.version as number, calculationMethod: r.calculation_method as string, baseComponentCodes: r.base_component_codes as string[],
  defaultAmount: (r.default_amount as string | null) ?? null, defaultPercentage: (r.default_percentage as string | null) ?? null, roundingMode: r.rounding_mode as string,
  roundingPlaces: r.rounding_places as number, isTaxable: r.is_taxable as boolean, prorateOnUnpaidDays: r.prorate_on_unpaid_days as boolean,
  statutoryGroup: (r.statutory_group as string | null) ?? null, configuration: r.configuration as Record<string, unknown>, effectiveFrom: r.effective_from as string,
  effectiveTo: (r.effective_to as string | null) ?? null, status: r.status as ComponentVersionView['status'],
});

const stripBranch = (v: AssignmentView & { branchId: string | null }): AssignmentView => {
  const out: Partial<typeof v> = { ...v };
  delete out.branchId;
  return out as AssignmentView;
};

@Injectable()
export class CompensationService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  // ---- components ---------------------------------------------------------------------------------
  async listComponents(a: RequestAuth): Promise<ComponentView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const comps = (await c.query('SELECT id, code, label, component_type, active FROM salary_components WHERE tenant_id=$1 ORDER BY code', [a.tenantId])).rows;
      const vers = (await c.query(`SELECT ${VERSION_COLS} FROM salary_component_versions WHERE tenant_id=$1 ORDER BY component_id, version`, [a.tenantId])).rows;
      return comps.map((x) => ({ id: x.id, code: x.code, label: x.label, componentType: x.component_type, active: x.active, versions: vers.filter((v) => v.component_id === x.id).map(versionView) }));
    });
  }
  async createComponent(a: RequestAuth, body: unknown): Promise<ComponentView> {
    const b = createComponent.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query('INSERT INTO salary_components (tenant_id, code, label, component_type) VALUES ($1,$2,$3,$4) RETURNING id, code, label, component_type, active', [a.tenantId, b.code, b.label, b.componentType])).rows[0]!;
      await this.audit.record(c, a, 'salary_component.create', 'salary_components', r.id, null, { code: b.code, type: b.componentType });
      return { id: r.id, code: r.code, label: r.label, componentType: r.component_type, active: r.active, versions: [] };
    });
  }
  async updateComponent(a: RequestAuth, id: string, body: unknown): Promise<{ id: string }> {
    const b = updateComponent.parse(body);
    if (b.label === undefined && b.active === undefined) throw new ApiError('validation_failed', 422, 'Nothing to update');
    return this.db.run(ctxOf(a), async (c) => {
      const r = await c.query('UPDATE salary_components SET label=COALESCE($3,label), active=COALESCE($4,active) WHERE tenant_id=$1 AND id=$2 RETURNING id', [a.tenantId, id, b.label ?? null, b.active ?? null]);
      if (!r.rowCount) throw notFound('component');
      await this.audit.record(c, a, 'salary_component.update', 'salary_components', id, null, b);
      return { id };
    });
  }
  async createVersion(a: RequestAuth, componentId: string, body: unknown): Promise<ComponentVersionView> {
    const b = createComponentVersion.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const comp = (await c.query<{ label: string; code: string }>('SELECT label, code FROM salary_components WHERE tenant_id=$1 AND id=$2', [a.tenantId, componentId])).rows[0];
      if (!comp) throw notFound('component');
      if (b.baseComponentCodes.length) {
        const known = (await c.query<{ code: string }>('SELECT code FROM salary_components WHERE tenant_id=$1 AND code = ANY($2::text[])', [a.tenantId, b.baseComponentCodes])).rows.map((x) => x.code);
        const missing = b.baseComponentCodes.filter((x) => !known.includes(x));
        if (missing.length) throw new ApiError('validation_failed', 422, `Unknown base component(s): ${missing.join(', ')}`, [{ path: 'baseComponentCodes', message: 'unknown component' }]);
        if (b.baseComponentCodes.includes(comp.code)) throw new ApiError('validation_failed', 422, 'A component cannot be a percentage of itself', [{ path: 'baseComponentCodes', message: 'self reference' }]);
      }
      const v = (await c.query<{ v: number }>('SELECT COALESCE(max(version),0)+1 AS v FROM salary_component_versions WHERE tenant_id=$1 AND component_id=$2', [a.tenantId, componentId])).rows[0]!.v;
      const r = (await c.query(
        `INSERT INTO salary_component_versions (tenant_id, component_id, version, label_snapshot, calculation_method, base_component_codes, default_amount, default_percentage,
            rounding_mode, rounding_places, is_taxable, prorate_on_unpaid_days, statutory_group, configuration, effective_from, effective_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${VERSION_COLS}`,
        [a.tenantId, componentId, v, comp.label, b.calculationMethod, b.baseComponentCodes, b.defaultAmount ?? null, b.defaultPercentage ?? null, b.roundingMode, b.roundingPlaces,
          b.isTaxable, b.prorateOnUnpaidDays, b.statutoryGroup ?? null, JSON.stringify(b.configuration), b.effectiveFrom, b.effectiveTo ?? null, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'salary_component_version.create', 'salary_component_versions', r.id, null, { code: comp.code, version: v });
      return versionView(r);
    });
  }
  async setVersionStatus(a: RequestAuth, versionId: string, to: 'active' | 'retired'): Promise<ComponentVersionView> {
    return this.db.run(ctxOf(a, `component version ${to}`), async (c) => {
      const cur = (await c.query<{ status: string; component_id: string; effective_from: string }>(
        `SELECT status, component_id, to_char(effective_from,'YYYY-MM-DD') AS effective_from FROM salary_component_versions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, versionId])).rows[0];
      if (!cur) throw notFound('component version');
      if (!((to === 'active' && cur.status === 'draft') || (to === 'retired' && cur.status === 'active'))) throw new ApiError('invalid_state', 409, `A ${cur.status} version cannot become ${to}`);
      if (to === 'active') {
        // The new version takes over from the one it follows.
        await c.query(
          `UPDATE salary_component_versions SET effective_to = $4::date - 1 WHERE tenant_id=$1 AND component_id=$2 AND id<>$3 AND status='active'
              AND effective_from < $4 AND (effective_to IS NULL OR effective_to >= $4)`, [a.tenantId, cur.component_id, versionId, cur.effective_from]);
      }
      const r = (await c.query(`UPDATE salary_component_versions SET status=$3 WHERE tenant_id=$1 AND id=$2 RETURNING ${VERSION_COLS}`, [a.tenantId, versionId, to])).rows[0]!;
      await this.audit.record(c, a, `salary_component_version.${to}`, 'salary_component_versions', versionId, { status: cur.status }, { status: to });
      return versionView(r);
    });
  }
  async deleteDraftVersion(a: RequestAuth, versionId: string): Promise<void> {
    await this.db.run(ctxOf(a), async (c) => {
      const used = await c.query('SELECT 1 FROM salary_structure_components WHERE tenant_id=$1 AND component_version_id=$2 LIMIT 1', [a.tenantId, versionId]);
      if (used.rowCount) throw new ApiError('conflict', 409, 'This version is used by a salary structure');
      const r = await c.query(`DELETE FROM salary_component_versions WHERE tenant_id=$1 AND id=$2 AND status='draft'`, [a.tenantId, versionId]);
      if (!r.rowCount) throw new ApiError('invalid_state', 409, 'Only draft versions can be deleted');
      await this.audit.record(c, a, 'salary_component_version.delete', 'salary_component_versions', versionId, null, null);
    });
  }

  // ---- structures ------------------------------------------------------------------------------------
  private async structureViews(c: PoolClient, tenantId: string, where = '', params: unknown[] = []): Promise<StructureView[]> {
    const s = (await c.query(`SELECT id, code, name, version, to_char(effective_from,'YYYY-MM-DD') AS effective_from, to_char(effective_to,'YYYY-MM-DD') AS effective_to, status
      FROM salary_structures WHERE tenant_id=$1 ${where} ORDER BY code, version DESC`, [tenantId, ...params])).rows;
    if (!s.length) return [];
    const comps = (await c.query(
      `SELECT sc.salary_structure_id, sc.component_version_id, sc.amount::text, sc.percentage::text, sc.display_order, comp.code, cv.label_snapshot
         FROM salary_structure_components sc
         JOIN salary_component_versions cv ON cv.tenant_id=sc.tenant_id AND cv.id=sc.component_version_id
         JOIN salary_components comp ON comp.tenant_id=cv.tenant_id AND comp.id=cv.component_id
        WHERE sc.tenant_id=$1 AND sc.salary_structure_id = ANY($2::uuid[]) ORDER BY sc.display_order, comp.code`, [tenantId, s.map((x) => x.id)])).rows;
    return s.map((x) => ({
      id: x.id, code: x.code, name: x.name, version: x.version, effectiveFrom: x.effective_from, effectiveTo: x.effective_to, status: x.status,
      components: comps.filter((k) => k.salary_structure_id === x.id).map((k) => ({ componentVersionId: k.component_version_id, componentCode: k.code, label: k.label_snapshot, amount: k.amount, percentage: k.percentage, displayOrder: k.display_order })),
    }));
  }
  async listStructures(a: RequestAuth): Promise<StructureView[]> { return this.db.run(ctxOf(a), (c) => this.structureViews(c, a.tenantId)); }

  private async checkStructureComponents(c: PoolClient, tenantId: string, items: Array<{ componentVersionId: string }>): Promise<void> {
    const ids = items.map((i) => i.componentVersionId);
    const rows = (await c.query<{ id: string; component_id: string }>('SELECT id, component_id FROM salary_component_versions WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [tenantId, ids])).rows;
    if (rows.length !== ids.length) throw new ApiError('validation_failed', 422, 'Unknown component version', [{ path: 'components', message: 'unknown component version' }]);
    if (new Set(rows.map((r) => r.component_id)).size !== rows.length) throw new ApiError('validation_failed', 422, 'A structure may include only one version of each component', [{ path: 'components', message: 'duplicate component' }]);
  }
  private async writeStructureComponents(c: PoolClient, tenantId: string, structureId: string, items: Array<{ componentVersionId: string; amount?: string | null; percentage?: string | null; displayOrder: number }>): Promise<void> {
    await c.query('DELETE FROM salary_structure_components WHERE tenant_id=$1 AND salary_structure_id=$2', [tenantId, structureId]);
    for (const i of items) {
      await c.query('INSERT INTO salary_structure_components (tenant_id, salary_structure_id, component_version_id, amount, percentage, display_order) VALUES ($1,$2,$3,$4,$5,$6)',
        [tenantId, structureId, i.componentVersionId, i.amount ?? null, i.percentage ?? null, i.displayOrder]);
    }
  }
  async createStructure(a: RequestAuth, body: unknown): Promise<StructureView> {
    const b = createStructure.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      await this.checkStructureComponents(c, a.tenantId, b.components);
      const v = (await c.query<{ v: number }>('SELECT COALESCE(max(version),0)+1 AS v FROM salary_structures WHERE tenant_id=$1 AND code=$2', [a.tenantId, b.code])).rows[0]!.v;
      const r = (await c.query<{ id: string }>('INSERT INTO salary_structures (tenant_id, code, name, version, effective_from, effective_to, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [a.tenantId, b.code, b.name, v, b.effectiveFrom, b.effectiveTo ?? null, a.userId])).rows[0]!;
      await this.writeStructureComponents(c, a.tenantId, r.id, b.components);
      await this.audit.record(c, a, 'salary_structure.create', 'salary_structures', r.id, null, { code: b.code, version: v });
      return (await this.structureViews(c, a.tenantId, 'AND id=$2', [r.id]))[0]!;
    });
  }
  async updateStructure(a: RequestAuth, id: string, body: unknown): Promise<StructureView> {
    const b = updateStructure.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query<{ status: string }>('SELECT status FROM salary_structures WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('salary structure');
      if (cur.status !== 'draft') throw new ApiError('invalid_state', 409, 'Only draft structures can be edited; create a new version');
      if (b.name !== undefined || b.effectiveFrom !== undefined || b.effectiveTo !== undefined) {
        await c.query(`UPDATE salary_structures SET name=COALESCE($3,name), effective_from=COALESCE($4,effective_from), effective_to=CASE WHEN $5::boolean THEN $6::date ELSE effective_to END WHERE tenant_id=$1 AND id=$2`,
          [a.tenantId, id, b.name ?? null, b.effectiveFrom ?? null, b.effectiveTo !== undefined, b.effectiveTo ?? null]);
      }
      if (b.components) { await this.checkStructureComponents(c, a.tenantId, b.components); await this.writeStructureComponents(c, a.tenantId, id, b.components); }
      await this.audit.record(c, a, 'salary_structure.update', 'salary_structures', id, null, { fields: Object.keys(b) });
      return (await this.structureViews(c, a.tenantId, 'AND id=$2', [id]))[0]!;
    });
  }
  async setStructureStatus(a: RequestAuth, id: string, to: 'active' | 'retired'): Promise<StructureView> {
    return this.db.run(ctxOf(a, `structure ${to}`), async (c) => {
      const cur = (await c.query<{ status: string; code: string; effective_from: string }>(
        `SELECT status, code, to_char(effective_from,'YYYY-MM-DD') AS effective_from FROM salary_structures WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('salary structure');
      if (!((to === 'active' && cur.status === 'draft') || (to === 'retired' && cur.status === 'active'))) throw new ApiError('invalid_state', 409, `A ${cur.status} structure cannot become ${to}`);
      if (to === 'active') {
        const notLive = (await c.query<{ code: string; v: number }>(
          `SELECT comp.code, cv.version v FROM salary_structure_components sc JOIN salary_component_versions cv ON cv.tenant_id=sc.tenant_id AND cv.id=sc.component_version_id
             JOIN salary_components comp ON comp.tenant_id=cv.tenant_id AND comp.id=cv.component_id WHERE sc.tenant_id=$1 AND sc.salary_structure_id=$2 AND cv.status<>'active'`, [a.tenantId, id])).rows;
        if (notLive.length) throw new ApiError('invalid_state', 409, `Activate these component versions first: ${notLive.map((x) => `${x.code} v${x.v}`).join(', ')}`);
        await c.query(`UPDATE salary_structures SET effective_to = $4::date - 1 WHERE tenant_id=$1 AND code=$2 AND id<>$3 AND status='active' AND effective_from < $4 AND (effective_to IS NULL OR effective_to >= $4)`,
          [a.tenantId, cur.code, id, cur.effective_from]);
      }
      await c.query('UPDATE salary_structures SET status=$3 WHERE tenant_id=$1 AND id=$2', [a.tenantId, id, to]);
      await this.audit.record(c, a, `salary_structure.${to}`, 'salary_structures', id, { status: cur.status }, { status: to });
      return (await this.structureViews(c, a.tenantId, 'AND id=$2', [id]))[0]!;
    });
  }
  async newStructureVersion(a: RequestAuth, id: string): Promise<StructureView> {
    return this.db.run(ctxOf(a), async (c) => {
      const src = (await this.structureViews(c, a.tenantId, 'AND id=$2', [id]))[0];
      if (!src) throw notFound('salary structure');
      const latest = (await c.query<{ v: number }>('SELECT max(version) AS v FROM salary_structures WHERE tenant_id=$1 AND code=$2', [a.tenantId, src.code])).rows[0]!.v;
      const r = (await c.query<{ id: string }>('INSERT INTO salary_structures (tenant_id, code, name, version, effective_from, created_by) VALUES ($1,$2,$3,$4,CURRENT_DATE,$5) RETURNING id', [a.tenantId, src.code, src.name, latest + 1, a.userId])).rows[0]!;
      await this.writeStructureComponents(c, a.tenantId, r.id, src.components.map((k) => ({ componentVersionId: k.componentVersionId, amount: k.amount, percentage: k.percentage, displayOrder: k.displayOrder })));
      await this.audit.record(c, a, 'salary_structure.new_version', 'salary_structures', r.id, null, { code: src.code, version: latest + 1 });
      return (await this.structureViews(c, a.tenantId, 'AND id=$2', [r.id]))[0]!;
    });
  }

  // ---- assignments (maker-checker) -----------------------------------------------------------------------
  private static readonly ASSIGN_SELECT = `SELECT s.id, s.employee_id, trim(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name, e.branch_id, s.salary_structure_id, st.code AS structure_code,
      s.revision, to_char(s.effective_from,'YYYY-MM-DD') AS effective_from, to_char(s.effective_to,'YYYY-MM-DD') AS effective_to, s.monthly_ctc::text, s.currency, s.change_reason,
      s.approval_status, s.created_by, s.approved_by
    FROM employee_salary_assignments s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id JOIN salary_structures st ON st.tenant_id=s.tenant_id AND st.id=s.salary_structure_id`;
  private async assignmentViews(c: PoolClient, tenantId: string, where: string, params: unknown[]): Promise<Array<AssignmentView & { branchId: string | null }>> {
    const rows = (await c.query(`${CompensationService.ASSIGN_SELECT} WHERE s.tenant_id=$1 AND s.superseded_at IS NULL ${where} ORDER BY s.effective_from DESC, s.revision DESC LIMIT 200`, [tenantId, ...params])).rows;
    if (!rows.length) return [];
    const ov = (await c.query('SELECT assignment_id, component_version_id, amount::text, percentage::text FROM employee_salary_overrides WHERE tenant_id=$1 AND assignment_id = ANY($2::uuid[])', [tenantId, rows.map((r) => r.id)])).rows;
    return rows.map((r) => ({
      id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, branchId: r.branch_id, salaryStructureId: r.salary_structure_id, structureCode: r.structure_code, revision: r.revision,
      effectiveFrom: r.effective_from, effectiveTo: r.effective_to, monthlyCtc: r.monthly_ctc, currency: r.currency, changeReason: r.change_reason, approvalStatus: r.approval_status,
      createdBy: r.created_by, approvedBy: r.approved_by,
      overrides: ov.filter((o) => o.assignment_id === r.id).map((o) => ({ componentVersionId: o.component_version_id, amount: o.amount, percentage: o.percentage })),
    }));
  }
  private async employee(c: PoolClient, a: RequestAuth, id: string): Promise<{ id: string; branch_id: string | null }> {
    const e = (await c.query<{ id: string; branch_id: string | null }>('SELECT id, branch_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
    if (!e) throw notFound('employee');
    return e;
  }
  private assertScope(a: RequestAuth, perm: 'salary.read_assignment' | 'salary.assign' | 'salary.approve_assignment', e: { id: string; branch_id: string | null }): void {
    const d = authorizeOnEmployee(a, perm, { tenantId: a.tenantId, branchId: e.branch_id, employeeId: e.id });
    if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
  }

  async listAssignments(a: RequestAuth, employeeId: string): Promise<AssignmentView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const e = await this.employee(c, a, employeeId);
      this.assertScope(a, 'salary.read_assignment', e);
      return (await this.assignmentViews(c, a.tenantId, 'AND s.employee_id=$2', [employeeId])).map(stripBranch);
    });
  }
  async pendingAssignments(a: RequestAuth): Promise<AssignmentView[]> {
    return this.db.run(ctxOf(a), async (c) => (await this.assignmentViews(c, a.tenantId, `AND s.approval_status='pending'`, []))
      .filter((v) => authorizeOnEmployee(a, 'salary.approve_assignment', { tenantId: a.tenantId, branchId: v.branchId, employeeId: v.employeeId }).allowed)
      .map(stripBranch));
  }

  async propose(a: RequestAuth, body: unknown): Promise<AssignmentView> {
    const b = proposeAssignment.parse(body);
    return this.db.run(ctxOf(a, b.changeReason), async (c) => {
      const e = await this.employee(c, a, b.employeeId);
      this.assertScope(a, 'salary.assign', e);
      const st = (await c.query<{ status: string; effective_from: string }>(`SELECT status, to_char(effective_from,'YYYY-MM-DD') AS effective_from FROM salary_structures WHERE tenant_id=$1 AND id=$2`, [a.tenantId, b.salaryStructureId])).rows[0];
      if (!st || st.status !== 'active') throw new ApiError('validation_failed', 422, 'The salary structure must be active', [{ path: 'salaryStructureId', message: 'not an active structure' }]);
      if (b.overrides.length) {
        const ok = (await c.query<{ n: number }>('SELECT count(*)::int n FROM salary_structure_components WHERE tenant_id=$1 AND salary_structure_id=$2 AND component_version_id = ANY($3::uuid[])',
          [a.tenantId, b.salaryStructureId, b.overrides.map((o) => o.componentVersionId)])).rows[0]!.n;
        if (ok !== new Set(b.overrides.map((o) => o.componentVersionId)).size) throw new ApiError('validation_failed', 422, 'Overrides must refer to components of the structure', [{ path: 'overrides', message: 'component not in structure' }]);
      }
      const rev = (await c.query<{ r: number }>('SELECT COALESCE(max(revision),0)+1 AS r FROM employee_salary_assignments WHERE tenant_id=$1 AND employee_id=$2', [a.tenantId, b.employeeId])).rows[0]!.r;
      const ins = (await c.query<{ id: string }>(
        `INSERT INTO employee_salary_assignments (tenant_id, employee_id, salary_structure_id, revision, effective_from, effective_to, monthly_ctc, change_reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.tenantId, b.employeeId, b.salaryStructureId, rev, b.effectiveFrom, b.effectiveTo ?? null, b.monthlyCtc, b.changeReason, a.userId])).rows[0]!;
      for (const o of b.overrides) await c.query('INSERT INTO employee_salary_overrides (tenant_id, assignment_id, component_version_id, amount, percentage) VALUES ($1,$2,$3,$4,$5)', [a.tenantId, ins.id, o.componentVersionId, o.amount ?? null, o.percentage ?? null]);
      await this.audit.record(c, a, 'salary_assignment.propose', 'employee_salary_assignments', ins.id, null, { employeeId: b.employeeId, effectiveFrom: b.effectiveFrom, revision: rev }, b.changeReason);
      return stripBranch((await this.assignmentViews(c, a.tenantId, 'AND s.id=$2', [ins.id]))[0]!);
    });
  }

  async review(a: RequestAuth, id: string, action: 'approve' | 'reject', body: unknown): Promise<AssignmentView> {
    const b = reviewAssignment.parse(body ?? {});
    return this.db.run(ctxOf(a, `salary assignment ${action}`), async (c) => {
      const cur = (await c.query<{ employee_id: string; approval_status: string; created_by: string | null; effective_from: string; effective_to: string | null }>(
        `SELECT employee_id, approval_status, created_by, to_char(effective_from,'YYYY-MM-DD') AS effective_from, to_char(effective_to,'YYYY-MM-DD') AS effective_to
           FROM employee_salary_assignments WHERE tenant_id=$1 AND id=$2 AND superseded_at IS NULL FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('salary assignment');
      const e = await this.employee(c, a, cur.employee_id);
      this.assertScope(a, 'salary.approve_assignment', e);
      if (cur.created_by === a.userId) throw new ApiError('maker_checker_violation', 403, 'You cannot approve a salary change you proposed');
      if (cur.approval_status !== 'pending') throw new ApiError('invalid_state', 409, `This assignment is already ${cur.approval_status}`);
      if (action === 'approve') {
        const overlapping = (await c.query<{ id: string; effective_from: string }>(
          `SELECT id, to_char(effective_from,'YYYY-MM-DD') AS effective_from FROM employee_salary_assignments
            WHERE tenant_id=$1 AND employee_id=$2 AND id<>$3 AND approval_status='approved' AND superseded_at IS NULL
              AND daterange(effective_from, effective_to, '[]') && daterange($4::date, $5::date, '[]') FOR UPDATE`, [a.tenantId, cur.employee_id, id, cur.effective_from, cur.effective_to])).rows;
        for (const o of overlapping) {
          if (o.effective_from > cur.effective_from) throw new ApiError('conflict', 409, `This overlaps an approved assignment starting ${o.effective_from}; end or revise that one first`);
          if (o.effective_from === cur.effective_from) await c.query('UPDATE employee_salary_assignments SET superseded_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, o.id]);
          else await c.query('UPDATE employee_salary_assignments SET effective_to = $3::date - 1 WHERE tenant_id=$1 AND id=$2', [a.tenantId, o.id, cur.effective_from]);
        }
        await c.query(`UPDATE employee_salary_assignments SET approval_status='approved', approved_by=$3, approved_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.userId]);
      } else {
        await c.query(`UPDATE employee_salary_assignments SET approval_status='rejected' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      }
      await this.audit.record(c, a, `salary_assignment.${action}`, 'employee_salary_assignments', id, { status: 'pending' }, { status: action === 'approve' ? 'approved' : 'rejected' }, b.comment);
      return stripBranch((await this.assignmentViews(c, a.tenantId, 'AND s.id=$2', [id]))[0]!);
    });
  }
}
