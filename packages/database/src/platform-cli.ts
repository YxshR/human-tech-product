import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, PoolClient } from 'pg';
import { seedSystemRoles, seedSystemRolesIn } from './seed';

/**
 * Platform-operator commands. They run as the SYSTEM role (never the API's app role), because activating payroll for a
 * company and publishing statutory rules are decisions the company must not be able to make for itself.
 * Every command writes an audit row with source='system' naming the operator.
 */

const RULE_GROUPS = ['pf', 'esi', 'professional_tax', 'tds', 'lwf', 'gratuity', 'bonus', 'minimum_wage', 'other'] as const;
const DEC = /^\d+(\.\d+)?$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const codes = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);

/** Same shapes the payroll engine understands (RuleDef). Returns a list of problems; empty means valid. */
export function validateRuleDefinition(d: unknown): string[] {
  if (!isObj(d)) return ['definition must be an object'];
  const bad: string[] = [];
  const dec = (k: string, required: boolean) => { if (d[k] === undefined) { if (required) bad.push(`${k} is required`); } else if (typeof d[k] !== 'string' || !DEC.test(d[k] as string)) bad.push(`${k} must be a decimal string such as "15000.00"`); };
  if (d.kind === 'percentage') {
    dec('rate', true); if (!codes(d.baseCodes)) bad.push('baseCodes must list at least one component code');
    for (const k of ['baseCeiling', 'baseFloor', 'applyIfBaseAtMost', 'maxAmount']) dec(k, false);
    if (typeof d.rate === 'string' && DEC.test(d.rate) && Number(d.rate) > 1) bad.push('rate is a fraction (0.12 means 12%)');
  } else if (d.kind === 'slab') {
    if (!codes(d.baseCodes)) bad.push('baseCodes must list at least one component code');
    const slabs = d.slabs;
    if (!Array.isArray(slabs) || slabs.length === 0) bad.push('slabs must be a non-empty list');
    else {
      let prev = -1;
      slabs.forEach((s, i) => {
        if (!isObj(s) || typeof s.amount !== 'string' || !DEC.test(s.amount)) { bad.push(`slabs[${i}].amount must be a decimal string`); return; }
        if (s.upTo === undefined) { if (i !== slabs.length - 1) bad.push(`slabs[${i}] has no upTo but is not the last slab`); return; }
        if (typeof s.upTo !== 'string' || !DEC.test(s.upTo)) { bad.push(`slabs[${i}].upTo must be a decimal string`); return; }
        if (Number(s.upTo) <= prev) bad.push(`slabs[${i}].upTo must be greater than the previous slab`);
        prev = Number(s.upTo);
      });
    }
  } else bad.push('kind must be "percentage" or "slab"');
  return bad;
}

export interface RuleFileEntry {
  ruleGroup: string; stateCode?: string | null; version: number; effectiveFrom: string; effectiveTo?: string | null;
  definition: unknown; sourceUrl: string; sourceReference?: string | null; sourcePublishedOn?: string | null;
}

export function parseRuleFile(text: string): RuleFileEntry[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('the rules file is not valid JSON'); }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('the rules file must be a non-empty JSON array');
  const problems: string[] = [];
  const out = raw.map((r, i): RuleFileEntry => {
    const at = `rule ${i + 1}`;
    if (!isObj(r)) { problems.push(`${at}: must be an object`); return r as never; }
    if (!RULE_GROUPS.includes(r.ruleGroup as never)) problems.push(`${at}: ruleGroup must be one of ${RULE_GROUPS.join(', ')}`);
    if (!Number.isInteger(r.version) || (r.version as number) < 1) problems.push(`${at}: version must be a positive integer`);
    if (!isDate(r.effectiveFrom)) problems.push(`${at}: effectiveFrom must be YYYY-MM-DD`);
    if (r.effectiveTo != null && (!isDate(r.effectiveTo) || (isDate(r.effectiveFrom) && r.effectiveTo < r.effectiveFrom))) problems.push(`${at}: effectiveTo must be a date on or after effectiveFrom`);
    if (r.stateCode != null && !(typeof r.stateCode === 'string' && /^[A-Z]{2}$/.test(r.stateCode))) problems.push(`${at}: stateCode must be two capital letters`);
    if (typeof r.sourceUrl !== 'string' || !/^https:\/\//.test(r.sourceUrl)) problems.push(`${at}: sourceUrl must be an https link to the official source`);
    if (r.sourcePublishedOn != null && !isDate(r.sourcePublishedOn)) problems.push(`${at}: sourcePublishedOn must be YYYY-MM-DD`);
    for (const p of validateRuleDefinition(r.definition)) problems.push(`${at}: ${p}`);
    return r as unknown as RuleFileEntry;
  });
  if (problems.length) throw new Error(`Rules not imported:\n - ${problems.join('\n - ')}`);
  return out;
}

async function operatorId(c: PoolClient, email: string): Promise<string> {
  const r = await c.query<{ id: string }>(`SELECT id FROM users WHERE email_normalized = lower($1) AND status = 'active'`, [email.trim()]);
  if (!r.rows[0]) throw new Error(`No active user with email ${email}. Operators sign in once before they can be named.`);
  return r.rows[0].id;
}
async function audit(c: PoolClient, tenantId: string | null, operatorEmail: string, action: string, entityType: string, entityId: string | null, after: unknown): Promise<void> {
  if (!tenantId) return;   // statutory rules are global; their history lives on the rule row itself
  await c.query(
    `INSERT INTO audit_logs (tenant_id, action, entity_type, entity_id, reason, after_redacted, source) VALUES ($1,$2,$3,$4,$5,$6,'system')`,
    [tenantId, action, entityType, entityId, `platform operator ${operatorEmail}`, JSON.stringify(after)]);
}
async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

export interface ActivationRequest { slug: string; displayName: string; requestedAt: string; activated: boolean }
/** Companies that asked for payroll and are still waiting (oldest first). */
export async function listPayrollRequests(pool: Pool): Promise<ActivationRequest[]> {
  const r = await pool.query(`SELECT slug, display_name, payroll_activation_requested_at AS at FROM tenants WHERE payroll_activation_requested_at IS NOT NULL AND payroll_activated_at IS NULL ORDER BY payroll_activation_requested_at`);
  return r.rows.map((x) => ({ slug: x.slug, displayName: x.display_name, requestedAt: (x.at as Date).toISOString(), activated: false }));
}

export async function activatePayroll(pool: Pool, slug: string, operatorEmail: string, opts: { allowWithoutRequest?: boolean } = {}): Promise<{ slug: string; activatedAt: string }> {
  return tx(pool, async (c) => {
    await operatorId(c, operatorEmail);
    const t = (await c.query(`SELECT id, status, payroll_activated_at, payroll_activation_requested_at FROM tenants WHERE slug=$1 FOR UPDATE`, [slug])).rows[0];
    if (!t) throw new Error(`No company with slug "${slug}"`);
    if (!['trial', 'active'].includes(t.status)) throw new Error(`Company "${slug}" is ${t.status}; only trial or active companies can be activated`);
    if (t.payroll_activated_at) throw new Error(`Payroll is already activated for "${slug}"`);
    if (!t.payroll_activation_requested_at && !opts.allowWithoutRequest) throw new Error(`"${slug}" has not requested payroll activation. Re-run with --force if the company asked you directly.`);
    const r = (await c.query<{ at: Date }>(`UPDATE tenants SET payroll_activated_at = now() WHERE id=$1 RETURNING payroll_activated_at AS at`, [t.id])).rows[0]!;
    await audit(c, t.id, operatorEmail, 'payroll.activate', 'tenants', t.id, { activatedAt: r.at.toISOString(), requested: !!t.payroll_activation_requested_at });
    return { slug, activatedAt: r.at.toISOString() };
  });
}

/** Loads rule versions as `in_review`, prepared by the named operator. A DIFFERENT operator must approve them. */
export async function importRules(pool: Pool, file: string, operatorEmail: string): Promise<{ imported: Array<{ id: string; ruleGroup: string; version: number }> }> {
  const entries = parseRuleFile(readFileSync(file, 'utf8'));
  return tx(pool, async (c) => {
    const by = await operatorId(c, operatorEmail);
    const imported: Array<{ id: string; ruleGroup: string; version: number }> = [];
    for (const e of entries) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO statutory_rule_sets (rule_group, state_code, version, effective_from, effective_to, definition, source_url, source_reference, source_published_on, status, prepared_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'in_review',$10) RETURNING id`,
        [e.ruleGroup, e.stateCode ?? null, e.version, e.effectiveFrom, e.effectiveTo ?? null, JSON.stringify(e.definition), e.sourceUrl, e.sourceReference ?? null, e.sourcePublishedOn ?? null, by])
        .catch((err: { code?: string }) => { throw err.code === '23505' ? new Error(`${e.ruleGroup} version ${e.version}${e.stateCode ? ` (${e.stateCode})` : ''} already exists; publish a new version number`) : err; });
      imported.push({ id: r.rows[0]!.id, ruleGroup: e.ruleGroup, version: e.version });
    }
    return { imported };
  });
}

export async function listRules(pool: Pool, status?: string): Promise<Array<{ id: string; ruleGroup: string; stateCode: string | null; version: number; effectiveFrom: string; status: string }>> {
  const r = await pool.query(`SELECT id, rule_group, state_code, version, effective_from::text AS from_d, status FROM statutory_rule_sets WHERE ($1::text IS NULL OR status=$1) ORDER BY rule_group, state_code NULLS FIRST, version`, [status ?? null]);
  return r.rows.map((x) => ({ id: x.id, ruleGroup: x.rule_group, stateCode: x.state_code, version: x.version, effectiveFrom: x.from_d, status: x.status }));
}

export async function approveRule(pool: Pool, ruleId: string, reviewerEmail: string, notes?: string): Promise<void> {
  await tx(pool, async (c) => {
    const reviewer = await operatorId(c, reviewerEmail);
    const cur = (await c.query(`SELECT status, prepared_by FROM statutory_rule_sets WHERE id=$1 FOR UPDATE`, [ruleId])).rows[0];
    if (!cur) throw new Error(`No rule with id ${ruleId}`);
    if (cur.status !== 'in_review') throw new Error(`The rule is ${cur.status}; only rules in review can be approved`);
    if (cur.prepared_by === reviewer) throw new Error('The person who prepared a rule cannot approve it');
    await c.query(`UPDATE statutory_rule_sets SET status='approved', reviewed_by=$2, reviewed_at=now(), review_notes=$3 WHERE id=$1`, [ruleId, reviewer, notes ?? null])
      .catch((err: { code?: string }) => { throw err.code === '23P01' ? new Error('That rule overlaps an approved version for the same group and state; set effectiveTo on the older one first') : err; });
  });
}

const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface NewCompany { slug: string; legalName: string; displayName?: string; adminEmail: string; operatorEmail: string; status?: 'trial' | 'active' }
/**
 * Creates a company, its system roles and a pending company_admin invitation for the first administrator, all in ONE
 * transaction. The administrator then signs in with their identity provider and accepts the link in the e-mail
 * (sent by the worker). Uses the OWNER connection (it writes roles and invitations before any user exists) and the
 * SYSTEM connection (for the audit row), exactly like migrations do - run it from the operations environment.
 * Returns the one-time token so the operator can hand the link over if e-mail is not set up yet.
 */
export async function createCompany(owner: Pool, system: Pool, c: NewCompany): Promise<{ tenantId: string; slug: string; inviteToken: string; expiresAt: string }> {
  if (!SLUG.test(c.slug)) throw new Error('slug must be 3-40 characters: lower-case letters, digits and "-", starting with a letter');
  const email = c.adminEmail.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error('admin e-mail is not valid');
  if (!c.legalName.trim()) throw new Error('company name is required');
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + INVITE_TTL_MS);
  const created = await tx(owner, async (db) => {
    const t = await db.query<{ id: string }>(
      `INSERT INTO tenants (slug, legal_name, display_name, status) VALUES ($1,$2,$3,$4) RETURNING id`,
      [c.slug, c.legalName.trim(), (c.displayName ?? c.legalName).trim(), c.status ?? 'trial'],
    ).catch((err: { code?: string }) => { throw err.code === '23505' ? new Error(`A company with slug "${c.slug}" already exists`) : err; });
    const tenantId = t.rows[0]!.id;
    await db.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.change_reason', 'company created by platform operator', true)`, [tenantId]);
    await seedSystemRolesIn(db, tenantId);
    const inv = (await db.query<{ id: string }>(
      `INSERT INTO invitations (tenant_id, email_normalized, token_hash, branch_scope_mode, invited_by, idempotency_key, expires_at)
       VALUES ($1,$2,$3,'all',NULL,$4,$5) RETURNING id`,
      [tenantId, email, createHash('sha256').update(token).digest(), randomBytes(16).toString('hex'), expires])).rows[0]!;
    await db.query(
      `INSERT INTO invitation_roles (tenant_id, invitation_id, role_id) SELECT $1, $2, id FROM roles WHERE tenant_id=$1 AND role_key='company_admin'`, [tenantId, inv.id]);
    await db.query(
      `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload_version, payload, idempotency_key)
       VALUES ($1,'invitations',$2,'invitation.email',1,$3,$4)`,
      [tenantId, inv.id, JSON.stringify({ email, token, expiresAt: expires.toISOString() }), `invitation-email:${inv.id}`]);
    return tenantId;
  });
  await tx(system, (db) => audit(db, created, c.operatorEmail, 'company.create', 'tenants', created, { slug: c.slug, adminEmail: email, status: c.status ?? 'trial' }));
  return { tenantId: created, slug: c.slug, inviteToken: token, expiresAt: expires.toISOString() };
}

/** Re-applies the system role definitions from the code to one company (or all). Run after a release that changes `packages/authz`. */
export async function syncRoles(owner: Pool, slug?: string): Promise<number> {
  const r = await owner.query<{ id: string }>(`SELECT id FROM tenants WHERE ($1::text IS NULL OR slug=$1) AND status <> 'closed'`, [slug ?? null]);
  if (slug && r.rowCount === 0) throw new Error(`No company with slug "${slug}"`);
  for (const t of r.rows) await seedSystemRoles(owner, t.id);
  return r.rowCount ?? 0;
}

// ---------------- public sign-up requests ----------------
export interface SignupRequestRow { id: string; planCode: string; companyName: string; contactName: string; email: string; phone: string | null; employeeCount: number | null; message: string | null; status: string; createdAt: string }
export async function listSignupRequests(system: Pool, status = 'awaiting_payment'): Promise<SignupRequestRow[]> {
  const r = await system.query(
    `SELECT id, plan_code, company_name, contact_name, email_normalized, phone, employee_count, message, status, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
       FROM signup_requests WHERE status=$1 ORDER BY created_at`, [status]);
  return r.rows.map((x) => ({ id: x.id, planCode: x.plan_code, companyName: x.company_name, contactName: x.contact_name, email: x.email_normalized, phone: x.phone, employeeCount: x.employee_count, message: x.message, status: x.status, createdAt: x.created_at }));
}

/**
 * Turns a paid sign-up request into a company: creates it (administrator = the person who asked), starts their plan's
 * subscription, and marks the request approved. Run it AFTER the payment has been received.
 */
export async function approveSignup(owner: Pool, system: Pool, requestId: string, slug: string, operatorEmail: string): Promise<{ tenantId: string; slug: string; inviteToken: string; expiresAt: string }> {
  const req = (await system.query(`SELECT id, plan_code, company_name, email_normalized, status FROM signup_requests WHERE id=$1`, [requestId])).rows[0];
  if (!req) throw new Error('No sign-up request with that id');
  if (req.status !== 'awaiting_payment') throw new Error(`That request is already ${req.status}`);
  const company = await createCompany(owner, system, { slug, legalName: req.company_name, adminEmail: req.email_normalized, operatorEmail, status: 'active' });
  await tx(owner, async (db) => {
    await db.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.change_reason', 'subscription started from sign-up request', true)`, [company.tenantId]);
    await db.query(
      `INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
       SELECT $1, id, 'active', current_date, (current_date + interval '1 month')::date FROM plans WHERE code=$2`, [company.tenantId, req.plan_code]);
  });
  await system.query(`UPDATE signup_requests SET status='approved', company_id=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$1`, [requestId, company.tenantId, operatorEmail]);
  return company;
}
