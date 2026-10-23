import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { authorizeOnEmployee, hasPermission } from '@humantech/authz';
import {
  BillingView, CustomFieldView, CustomValueType, PRIVACY_TRANSITIONS, PrivacyRequestView, RetentionView, VIEW_ENTITIES, ViewView,
  createCustomField, createPrivacyRequest, createView, setCustomValues, setRetention, updateCustomField, updatePrivacyRequest, updateView,
} from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { ApiError, forbidden, notFound } from '../common/errors';

type Row = Record<string, unknown>;
const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const bad = (path: string, message: string) => new ApiError('validation_failed', 422, message, [{ path, message }]);
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);

/** Checks one custom value against its definition. Returns the value to store (null clears it). */
export function checkCustomValue(def: { value_type: CustomValueType; options: string[]; label: string }, v: unknown): unknown {
  if (v === null) return null;
  const fail = (m: string) => bad(`values`, `${def.label}: ${m}`);
  const str = (max: number) => { if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw fail(`expected text up to ${max} characters`); return v.trim(); };
  switch (def.value_type) {
    case 'short_text': return str(200);
    case 'long_text': return str(4000);
    case 'email': { const s = str(200).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw fail('expected an email address'); return s; }
    case 'phone': { const s = str(30); if (!/^\+?[0-9][0-9 ()-]{6,19}$/.test(s)) throw fail('expected a phone number'); return s; }
    case 'url': { const s = str(500); try { if (!/^https?:$/.test(new URL(s).protocol)) throw new Error(); } catch { throw fail('expected an http(s) link'); } return s; }
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) throw fail('expected a number'); return v;
    case 'checkbox': if (typeof v !== 'boolean') throw fail('expected true or false'); return v;
    case 'date': { const s = str(10); const d = new Date(`${s}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw fail('expected a date as YYYY-MM-DD'); return s; }
    case 'single_select': { const s = str(60); if (!def.options.includes(s)) throw fail(`choose one of: ${def.options.join(', ')}`); return s; }
    case 'multi_select': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !def.options.includes(x)) || new Set(v).size !== v.length) throw fail(`choose any of: ${def.options.join(', ')}`);
      return v;
    }
  }
}

@Injectable()
export class SettingsService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  // ---------------- custom fields ----------------
  private fieldView(r: Row): CustomFieldView {
    return { id: r.id as string, entityType: r.entity_type as string, internalKey: r.internal_key as string, label: r.label as string, valueType: r.value_type as string, required: r.required as boolean, options: r.options as string[], active: r.active as boolean };
  }
  async listFields(a: RequestAuth, entityType?: string): Promise<CustomFieldView[]> {
    if (entityType !== undefined && entityType !== 'employee' && entityType !== 'candidate') throw bad('entityType', 'expected employee or candidate');
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT * FROM custom_field_definitions WHERE tenant_id=$1 AND ($2::text IS NULL OR entity_type=$2) AND entity_type IN ('employee','candidate') ORDER BY entity_type, label`, [a.tenantId, entityType ?? null])).rows.map((r) => this.fieldView(r)));
  }
  async createField(a: RequestAuth, body: unknown): Promise<CustomFieldView> {
    const b = createCustomField.parse(body);
    return this.db.run(ctxOf(a, 'custom field created'), async (c) => {
      const r = (await c.query(
        `INSERT INTO custom_field_definitions (tenant_id, entity_type, internal_key, label, value_type, required, options) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [a.tenantId, b.entityType, b.internalKey, b.label, b.valueType, b.required, JSON.stringify(b.options ?? [])])).rows[0]!;
      await this.audit.record(c, a, 'custom_field.create', 'custom_field_definitions', r.id, null, { entityType: b.entityType, key: b.internalKey, type: b.valueType });
      return this.fieldView(r);
    });
  }
  async updateField(a: RequestAuth, id: string, body: unknown): Promise<CustomFieldView> {
    const b = updateCustomField.parse(body);
    return this.db.run(ctxOf(a, 'custom field updated'), async (c) => {
      const cur = (await c.query(`SELECT * FROM custom_field_definitions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('custom field');
      const isSelect = cur.value_type === 'single_select' || cur.value_type === 'multi_select';
      if (b.options !== undefined && !isSelect) throw bad('options', 'only select fields have options');
      const r = (await c.query(
        `UPDATE custom_field_definitions SET label=COALESCE($3,label), required=COALESCE($4,required), options=COALESCE($5::jsonb,options), active=COALESCE($6,active) WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [a.tenantId, id, b.label ?? null, b.required ?? null, b.options ? JSON.stringify(b.options) : null, b.active ?? null])).rows[0]!;
      await this.audit.record(c, a, 'custom_field.update', 'custom_field_definitions', id, { label: cur.label, required: cur.required, active: cur.active }, b);
      return this.fieldView(r);
    });
  }

  private async assertEntityAccess(c: PoolClient, a: RequestAuth, entity: 'employee' | 'candidate', id: string, write: boolean): Promise<void> {
    if (entity === 'employee') {
      const e = (await c.query<{ id: string; branch_id: string | null }>('SELECT id, branch_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
      if (!e) throw notFound('employee');
      const d = authorizeOnEmployee(a, write ? 'employee.update' : 'employee.read', { tenantId: a.tenantId, branchId: e.branch_id, employeeId: e.id }, write ? {} : { allowOwn: 'profile.read_own', allowTeam: true });
      if (!d.allowed) throw d.reason === 'missing_permission' ? forbidden() : notFound('employee');
    } else {
      if (!hasPermission(a, write ? 'candidate.update' : 'candidate.read')) throw forbidden();
      const e = (await c.query('SELECT 1 FROM candidates WHERE tenant_id=$1 AND id=$2', [a.tenantId, id])).rows[0];
      if (!e) throw notFound('candidate');
    }
  }
  async getValues(a: RequestAuth, entity: 'employee' | 'candidate', id: string): Promise<Array<CustomFieldView & { value: unknown }>> {
    return this.db.run(ctxOf(a), async (c) => {
      await this.assertEntityAccess(c, a, entity, id, false);
      const rows = (await c.query(
        `SELECT d.*, v.value_json FROM custom_field_definitions d LEFT JOIN custom_field_values v ON v.tenant_id=d.tenant_id AND v.definition_id=d.id AND v.entity_type=d.entity_type AND v.entity_id=$3
         WHERE d.tenant_id=$1 AND d.entity_type=$2 AND (d.active OR v.value_json IS NOT NULL) ORDER BY d.label`, [a.tenantId, entity, id])).rows;
      return rows.map((r) => ({ ...this.fieldView(r), value: r.value_json ?? null }));
    });
  }
  async setValues(a: RequestAuth, entity: 'employee' | 'candidate', id: string, body: unknown): Promise<Array<CustomFieldView & { value: unknown }>> {
    const { values } = setCustomValues.parse(body);
    const keys = Object.keys(values);
    if (keys.length === 0) throw bad('values', 'nothing to update');
    await this.db.run(ctxOf(a, 'custom fields updated'), async (c) => {
      await this.assertEntityAccess(c, a, entity, id, true);
      const defs = (await c.query(`SELECT * FROM custom_field_definitions WHERE tenant_id=$1 AND entity_type=$2 AND internal_key = ANY($3::text[])`, [a.tenantId, entity, keys])).rows;
      const byKey = new Map(defs.map((d) => [d.internal_key as string, d]));
      for (const k of keys) {
        const d = byKey.get(k);
        if (!d) throw bad(`values.${k}`, `unknown field "${k}"`);
        if (!d.active) throw bad(`values.${k}`, `field "${k}" is no longer in use`);
      }
      const written: Record<string, unknown> = {};
      for (const k of keys) {
        const d = byKey.get(k)!;
        const v = checkCustomValue(d, values[k]);
        if (v === null && d.required) throw bad(`values.${k}`, `${d.label} is required`);
        await c.query(
          `INSERT INTO custom_field_values (tenant_id, definition_id, entity_type, entity_id, value_json, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, definition_id, entity_type, entity_id) DO UPDATE SET value_json=EXCLUDED.value_json, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [a.tenantId, d.id, entity, id, v === null ? null : JSON.stringify(v), a.userId]);
        written[k] = v;
      }
      await this.audit.record(c, a, 'custom_field.set_values', entity === 'employee' ? 'employees' : 'candidates', id, null, { fields: keys });
    });
    return this.getValues(a, entity, id);
  }

  // ---------------- saved views ----------------
  private viewOut(r: Row, userId: string): ViewView {
    return { id: r.id as string, entityType: r.entity_type as string, name: r.name as string, config: r.config as ViewView['config'], shared: r.is_shared as boolean, mine: r.owner_user_id === userId };
  }
  private checkViewConfig(entity: string, cfg: ViewView['config']): void {
    const spec = VIEW_ENTITIES[entity];
    if (!spec) throw bad('entityType', 'unknown list');
    for (const col of cfg.columns ?? []) if (!spec.columns.includes(col)) throw bad('config.columns', `unknown column "${col}"`);
    for (const f of Object.keys(cfg.filters ?? {})) if (!spec.filters.includes(f)) throw bad('config.filters', `unknown filter "${f}"`);
    if (cfg.sort && !spec.columns.includes(cfg.sort.key)) throw bad('config.sort', `cannot sort by "${cfg.sort.key}"`);
  }
  async listViews(a: RequestAuth, entityType?: string): Promise<ViewView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT * FROM saved_views WHERE tenant_id=$1 AND ($2::text IS NULL OR entity_type=$2) AND (owner_user_id=$3 OR is_shared) ORDER BY entity_type, name`, [a.tenantId, entityType ?? null, a.userId])).rows.map((r) => this.viewOut(r, a.userId)));
  }
  async createView(a: RequestAuth, body: unknown): Promise<ViewView> {
    const b = createView.parse(body);
    this.checkViewConfig(b.entityType, b.config);
    if (b.shared && !hasPermission(a, 'view.manage_shared')) throw forbidden('You cannot share views with the company');
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(`INSERT INTO saved_views (tenant_id, owner_user_id, entity_type, name, config, is_shared) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [a.tenantId, a.userId, b.entityType, b.name, JSON.stringify(b.config), b.shared])).rows[0]!;
      return this.viewOut(r, a.userId);
    });
  }
  async updateView(a: RequestAuth, id: string, body: unknown): Promise<ViewView> {
    const b = updateView.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query(`SELECT * FROM saved_views WHERE tenant_id=$1 AND id=$2 AND (owner_user_id=$3 OR is_shared) FOR UPDATE`, [a.tenantId, id, a.userId])).rows[0];
      if (!cur) throw notFound('view');
      this.assertViewEditable(a, cur);
      if (b.config) this.checkViewConfig(cur.entity_type, b.config);
      if (b.shared && !hasPermission(a, 'view.manage_shared')) throw forbidden('You cannot share views with the company');
      const r = (await c.query(`UPDATE saved_views SET name=COALESCE($3,name), config=COALESCE($4::jsonb,config), is_shared=COALESCE($5,is_shared) WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [a.tenantId, id, b.name ?? null, b.config ? JSON.stringify(b.config) : null, b.shared ?? null])).rows[0]!;
      return this.viewOut(r, a.userId);
    });
  }
  async deleteView(a: RequestAuth, id: string): Promise<void> {
    await this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query(`SELECT * FROM saved_views WHERE tenant_id=$1 AND id=$2 AND (owner_user_id=$3 OR is_shared)`, [a.tenantId, id, a.userId])).rows[0];
      if (!cur) throw notFound('view');
      this.assertViewEditable(a, cur);
      await c.query('DELETE FROM saved_views WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
    });
  }
  /** Own views are always editable; someone else's shared view only by people who can manage shared views. */
  private assertViewEditable(a: RequestAuth, v: Row): void {
    if (v.owner_user_id !== a.userId && !hasPermission(a, 'view.manage_shared')) throw forbidden('This view belongs to someone else');
  }

  // ---------------- privacy ----------------
  private privacyOut(r: Row): PrivacyRequestView {
    return {
      id: r.id as string, requestType: r.request_type as string, status: r.status as string, subjectEmployeeId: (r.subject_employee_id as string | null) ?? null,
      subjectCandidateId: (r.subject_candidate_id as string | null) ?? null, details: (r.details as string | null) ?? null, dueAt: iso(r.due_at), handledBy: (r.handled_by as string | null) ?? null,
      resolutionNote: (r.resolution_note as string | null) ?? null, createdAt: iso(r.created_at)!, completedAt: iso(r.completed_at),
    };
  }
  async createPrivacy(a: RequestAuth, body: unknown): Promise<PrivacyRequestView> {
    const b = createPrivacyRequest.parse(body);
    const manager = hasPermission(a, 'privacy.manage');
    return this.db.run(ctxOf(a, 'privacy request received'), async (c) => {
      let employeeId = b.subjectEmployeeId ?? null; const candidateId = b.subjectCandidateId ?? null;
      if (employeeId && candidateId) throw bad('subjectCandidateId', 'name one person, not both');
      if (!employeeId && !candidateId) {
        employeeId = (await c.query<{ id: string }>('SELECT id FROM employees WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, a.userId])).rows[0]?.id ?? null;
        if (!employeeId) throw bad('subjectEmployeeId', 'you have no employee record; ask your HR team to file this for you');
      }
      if (employeeId) {
        const e = (await c.query<{ user_id: string | null }>('SELECT user_id FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, employeeId])).rows[0];
        if (!e) throw notFound('employee');
        if (e.user_id !== a.userId && !manager) throw notFound('employee');
      } else {
        if (!manager) throw forbidden();
        if (!(await c.query('SELECT 1 FROM candidates WHERE tenant_id=$1 AND id=$2', [a.tenantId, candidateId])).rows[0]) throw notFound('candidate');
      }
      const r = (await c.query(
        `INSERT INTO privacy_requests (tenant_id, subject_employee_id, subject_candidate_id, request_type, details, due_at) VALUES ($1,$2,$3,$4,$5, now() + interval '30 days') RETURNING *`,
        [a.tenantId, employeeId, candidateId, b.requestType, b.details ?? null])).rows[0]!;
      await this.audit.record(c, a, 'privacy.request', 'privacy_requests', r.id, null, { type: b.requestType, employee: employeeId, candidate: candidateId });
      return this.privacyOut(r);
    });
  }
  async listPrivacy(a: RequestAuth, status?: string): Promise<PrivacyRequestView[]> {
    const manager = hasPermission(a, 'privacy.manage');
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT p.* FROM privacy_requests p LEFT JOIN employees e ON e.tenant_id=p.tenant_id AND e.id=p.subject_employee_id
       WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.status=$2) AND ($3::boolean OR e.user_id=$4) ORDER BY p.created_at DESC LIMIT 200`, [a.tenantId, status ?? null, manager, a.userId])).rows.map((r) => this.privacyOut(r)));
  }
  async updatePrivacy(a: RequestAuth, id: string, body: unknown): Promise<PrivacyRequestView> {
    const b = updatePrivacyRequest.parse(body);
    return this.db.run(ctxOf(a, 'privacy request handled'), async (c) => {
      const cur = (await c.query('SELECT * FROM privacy_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('privacy request');
      if (!(PRIVACY_TRANSITIONS[cur.status as string] ?? []).includes(b.status)) throw new ApiError('invalid_state', 409, `A ${cur.status} request cannot become ${b.status}`);
      if ((b.status === 'completed' || b.status === 'rejected') && !b.resolutionNote) throw bad('resolutionNote', 'explain the outcome to the person who asked');
      const done = b.status === 'completed' || b.status === 'rejected';
      const r = (await c.query(
        `UPDATE privacy_requests SET status=$3, handled_by=$4, resolution_note=COALESCE($5,resolution_note), completed_at=CASE WHEN $6 THEN now() ELSE completed_at END WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [a.tenantId, id, b.status, a.userId, b.resolutionNote ?? null, done])).rows[0]!;
      await this.audit.record(c, a, 'privacy.update', 'privacy_requests', id, { status: cur.status }, { status: b.status });
      return this.privacyOut(r);
    });
  }
  async listRetention(a: RequestAuth): Promise<RetentionView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query('SELECT * FROM data_retention_policies WHERE tenant_id=$1 ORDER BY entity_type', [a.tenantId])).rows
      .map((r) => ({ entityType: r.entity_type, retainMonths: r.retain_months, actionAfter: r.action_after, legalBasis: r.legal_basis ?? null })));
  }
  async setRetention(a: RequestAuth, body: unknown): Promise<RetentionView> {
    const b = setRetention.parse(body);
    return this.db.run(ctxOf(a, 'retention policy set'), async (c) => {
      const before = (await c.query('SELECT retain_months, action_after FROM data_retention_policies WHERE tenant_id=$1 AND entity_type=$2', [a.tenantId, b.entityType])).rows[0] ?? null;
      await c.query(
        `INSERT INTO data_retention_policies (tenant_id, entity_type, retain_months, action_after, legal_basis, reviewed_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, entity_type) DO UPDATE SET retain_months=EXCLUDED.retain_months, action_after=EXCLUDED.action_after, legal_basis=EXCLUDED.legal_basis, reviewed_by=EXCLUDED.reviewed_by`,
        [a.tenantId, b.entityType, b.retainMonths, b.actionAfter, b.legalBasis ?? null, a.userId]);
      await this.audit.record(c, a, 'retention.set', 'data_retention_policies', null, before, { entityType: b.entityType, retainMonths: b.retainMonths, actionAfter: b.actionAfter });
      return { entityType: b.entityType, retainMonths: b.retainMonths, actionAfter: b.actionAfter, legalBasis: b.legalBasis ?? null };
    });
  }

  // ---------------- billing (read only) ----------------
  async billing(a: RequestAuth): Promise<BillingView> {
    return this.db.run(ctxOf(a), async (c) => {
      const s = (await c.query(
        `SELECT s.*, s.current_period_end::text AS current_period_end_text, p.code, p.name, p.max_active_employees, p.max_branches, p.monthly_price, p.currency FROM subscriptions s JOIN plans p ON p.id=s.plan_id
         WHERE s.tenant_id=$1 ORDER BY (s.status IN ('trialing','active','past_due')) DESC, s.created_at DESC LIMIT 1`, [a.tenantId])).rows[0];
      const counts = (await c.query<{ emp: string; br: string }>(
        `SELECT (SELECT count(*) FROM employees WHERE tenant_id=$1 AND employment_status IN ('onboarding','active','probation','on_notice'))::text AS emp,
                (SELECT count(*) FROM branches WHERE tenant_id=$1 AND status='active')::text AS br`, [a.tenantId])).rows[0]!;
      const inv = (await c.query(`SELECT *, period_start::text AS ps, period_end::text AS pe FROM saas_invoices WHERE tenant_id=$1 AND status <> 'draft' ORDER BY issued_at DESC LIMIT 24`, [a.tenantId])).rows;
      return {
        plan: s ? { code: s.code, name: s.name, maxActiveEmployees: s.max_active_employees ?? null, maxBranches: s.max_branches ?? null, monthlyPrice: s.monthly_price ?? null, currency: s.currency } : null,
        subscription: s ? { status: s.status, trialEndsAt: iso(s.trial_ends_at), currentPeriodEnd: s.current_period_end_text ?? null, overLimitBehaviour: s.over_limit_behaviour, employeeLimit: s.employee_limit_override ?? s.max_active_employees ?? null } : null,
        usage: { activeEmployees: Number(counts.emp), branches: Number(counts.br) },
        invoices: inv.map((i) => ({ invoiceNumber: i.invoice_number, periodStart: i.ps, periodEnd: i.pe, amount: i.amount, currency: i.currency, status: i.status, issuedAt: iso(i.issued_at)! })),
      };
    });
  }
}
