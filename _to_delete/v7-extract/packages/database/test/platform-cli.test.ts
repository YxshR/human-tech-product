import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { activatePayroll, approveRule, createCompany, syncRoles, importRules, listPayrollRequests, listRules, parseRuleFile, validateRuleDefinition } from '../src';
import { closePools, makeTenant, makeUser, pools } from './helpers';

afterAll(closePools);

const dir = mkdtempSync(join(tmpdir(), 'ht-rules-'));
const file = (name: string, v: unknown) => { const p = join(dir, name); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); return p; };
const emailOf = async (id: string) => (await pools.admin.query<{ e: string }>('SELECT email_normalized AS e FROM users WHERE id=$1', [id])).rows[0]!.e;
const pf = (version: number, from = '2030-01-01') => ({ ruleGroup: 'pf', version, effectiveFrom: from, definition: { kind: 'percentage', rate: '0.12', baseCodes: ['BASIC'], baseCeiling: '15000' }, sourceUrl: 'https://example.test/pf' });

describe('payroll activation', () => {
  it('lists requests, activates once, audits, and refuses unrequested or unknown companies', async () => {
    const T = await makeTenant('act'); const op = await emailOf(await makeUser('operator'));
    expect((await listPayrollRequests(pools.system)).map((r) => r.slug)).not.toContain(T.slug);
    await expect(activatePayroll(pools.system, T.slug, op)).rejects.toThrow('has not requested');
    await pools.admin.query('UPDATE tenants SET payroll_activation_requested_at = now() WHERE id=$1', [T.tenantId]);
    expect((await listPayrollRequests(pools.system)).map((r) => r.slug)).toContain(T.slug);
    const r = await activatePayroll(pools.system, T.slug, op);
    expect(new Date(r.activatedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await listPayrollRequests(pools.system)).map((x) => x.slug)).not.toContain(T.slug);
    await expect(activatePayroll(pools.system, T.slug, op)).rejects.toThrow('already activated');
    await expect(activatePayroll(pools.system, 'no-such-co', op)).rejects.toThrow('No company');
    await expect(activatePayroll(pools.system, T.slug, 'stranger@nowhere.test')).rejects.toThrow('No active user');
    const a = await pools.admin.query(`SELECT source, reason, action FROM audit_logs WHERE tenant_id=$1 AND action='payroll.activate'`, [T.tenantId]);
    expect(a.rows).toEqual([{ source: 'system', reason: `platform operator ${op}`, action: 'payroll.activate' }]);
  });
  it('--force activates a company that never asked, but not a suspended one', async () => {
    const T = await makeTenant('frc'); const op = await emailOf(await makeUser('operator2'));
    expect((await activatePayroll(pools.system, T.slug, op, { allowWithoutRequest: true })).slug).toBe(T.slug);
    const S = await makeTenant('sus');
    await pools.admin.query(`UPDATE tenants SET status='suspended' WHERE id=$1`, [S.tenantId]);
    await expect(activatePayroll(pools.system, S.slug, op, { allowWithoutRequest: true })).rejects.toThrow('suspended');
  });
});

describe('statutory rules', () => {
  it('validates definitions before touching the database', () => {
    expect(validateRuleDefinition({ kind: 'percentage', rate: '0.12', baseCodes: ['BASIC'] })).toEqual([]);
    expect(validateRuleDefinition({ kind: 'slab', baseCodes: ['GROSS'], slabs: [{ upTo: '10000', amount: '0' }, { upTo: '15000', amount: '150' }, { amount: '200' }] })).toEqual([]);
    expect(validateRuleDefinition({ kind: 'percentage', rate: '12', baseCodes: ['BASIC'] })).toEqual(['rate is a fraction (0.12 means 12%)']);
    expect(validateRuleDefinition({ kind: 'percentage', rate: 0.12, baseCodes: [] })).toHaveLength(2);
    expect(validateRuleDefinition({ kind: 'slab', baseCodes: ['G'], slabs: [{ upTo: '10', amount: '1' }, { upTo: '5', amount: '2' }] })[0]).toContain('greater than the previous');
    expect(validateRuleDefinition({ kind: 'slab', baseCodes: ['G'], slabs: [{ amount: '1' }, { upTo: '5', amount: '2' }] })[0]).toContain('not the last');
    expect(validateRuleDefinition({ kind: 'magic' })).toEqual(['kind must be "percentage" or "slab"']);
    expect(validateRuleDefinition('x')).toEqual(['definition must be an object']);
  });
  it('rejects a bad file with every problem listed', () => {
    expect(() => parseRuleFile('{')).toThrow('not valid JSON');
    expect(() => parseRuleFile('[]')).toThrow('non-empty');
    try { parseRuleFile(JSON.stringify([{ ruleGroup: 'nope', version: 0, effectiveFrom: '2030-13-01', definition: {}, sourceUrl: 'http://x' }])); throw new Error('should fail'); } catch (e) {
      const m = (e as Error).message; for (const part of ['ruleGroup', 'version', 'effectiveFrom', 'sourceUrl', 'kind must be']) expect(m).toContain(part);
    }
  });
  it('imports for review; a different operator approves; the preparer cannot; approved rules are frozen', async () => {
    const prep = await emailOf(await makeUser('prep')); const rev = await emailOf(await makeUser('rev'));
    const out = await importRules(pools.system, file('a.json', [pf(901, '2051-01-01'), { ...pf(901, '2051-01-01'), ruleGroup: 'esi', definition: { kind: 'percentage', rate: '0.0075', baseCodes: ['GROSS'], applyIfBaseAtMost: '21000' } }]), prep);
    expect(out.imported).toHaveLength(2);
    const id = out.imported[0]!.id;
    expect((await listRules(pools.system, 'in_review')).map((r) => r.id)).toContain(id);
    await expect(approveRule(pools.system, id, prep)).rejects.toThrow('cannot approve');
    await approveRule(pools.system, id, rev, 'checked against the gazette');
    const row = (await pools.admin.query(`SELECT status, review_notes FROM statutory_rule_sets WHERE id=$1`, [id])).rows[0];
    expect(row).toEqual({ status: 'approved', review_notes: 'checked against the gazette' });
    await expect(approveRule(pools.system, id, rev)).rejects.toThrow('only rules in review');
    await expect(approveRule(pools.system, '00000000-0000-4000-8000-000000000000', rev)).rejects.toThrow('No rule');
    await expect(importRules(pools.system, file('b.json', [pf(901, '2051-01-01')]), prep)).rejects.toThrow('already exists');
    await expect(pools.system.query(`UPDATE statutory_rule_sets SET definition='{"kind":"percentage","rate":"0.5","baseCodes":["X"]}' WHERE id=$1`, [id])).rejects.toMatchObject({ code: 'HT002' });
  });
  it('refuses to approve a rule that overlaps an approved one', async () => {
    const prep = await emailOf(await makeUser('prep2')); const rev = await emailOf(await makeUser('rev2'));
    const a = await importRules(pools.system, file('c.json', [{ ...pf(902, '2060-01-01'), stateCode: 'KA' }]), prep);
    await approveRule(pools.system, a.imported[0]!.id, rev);
    const b = await importRules(pools.system, file('d.json', [{ ...pf(903, '2060-06-01'), stateCode: 'KA' }]), prep);
    await expect(approveRule(pools.system, b.imported[0]!.id, rev)).rejects.toThrow('overlaps');
  });
});

describe('system role limits', () => {
  it('can write system audit rows only, and never rewrite them', async () => {
    const T = await makeTenant('lim');
    await expect(pools.system.query(`INSERT INTO audit_logs (tenant_id, action, entity_type, source) VALUES ($1,'x','tenants','api')`, [T.tenantId])).rejects.toMatchObject({ code: '42501' });
    await expect(pools.system.query(`UPDATE audit_logs SET reason='x' WHERE tenant_id=$1`, [T.tenantId])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('company creation', () => {
  const owner = () => pools.owner;
  it('creates the company, its roles and a pending company_admin invitation, and the invitation can be accepted', async () => {
    const slug = `newco-${Date.now().toString(36)}`;
    const r = await createCompany(owner(), pools.system, { slug, legalName: 'New Co Pvt Ltd', adminEmail: ' Boss@NewCo.test ', operatorEmail: 'ops@humantech.test' });
    const q = async (sql: string, args: unknown[] = []) => (await pools.admin.query(sql, args)).rows;
    expect((await q('SELECT status, display_name FROM tenants WHERE id=$1', [r.tenantId]))[0]).toEqual({ status: 'trial', display_name: 'New Co Pvt Ltd' });
    expect((await q('SELECT count(*)::int AS n FROM roles WHERE tenant_id=$1', [r.tenantId]))[0].n).toBeGreaterThanOrEqual(9);
    const inv = (await q(`SELECT i.status, i.email_normalized, i.invited_by, array_agg(ro.role_key) AS roles FROM invitations i JOIN invitation_roles ir ON ir.invitation_id=i.id JOIN roles ro ON ro.id=ir.role_id WHERE i.tenant_id=$1 GROUP BY 1,2,3`, [r.tenantId]))[0];
    expect(inv).toEqual({ status: 'pending', email_normalized: 'boss@newco.test', invited_by: null, roles: ['company_admin'] });
    const job = (await q(`SELECT event_type, payload FROM outbox_events WHERE tenant_id=$1`, [r.tenantId]))[0];
    expect(job.event_type).toBe('invitation.email');
    expect(job.payload.token).toBe(r.inviteToken);
    expect((await q(`SELECT source, reason, action FROM audit_logs WHERE tenant_id=$1 AND action='company.create'`, [r.tenantId]))[0]).toEqual({ source: 'system', reason: 'platform operator ops@humantech.test', action: 'company.create' });

    // The administrator signs in (user row exists with that e-mail) and accepts: they become company_admin.
    const userId = (await pools.admin.query<{ id: string }>(`INSERT INTO users (identity_subject, email_normalized, display_name) VALUES ($1,'boss@newco.test','Boss') RETURNING id`, [`sub-${slug}`])).rows[0]!.id;
    const token = createHash('sha256').update(r.inviteToken).digest();
    const c = await pools.app.connect();
    try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.user_id',$1,true)`, [userId]); await c.query('SELECT app.accept_invitation($1,$2)', [token, userId]); await c.query('COMMIT'); } finally { c.release(); }
    expect((await q(`SELECT ro.role_key FROM membership_roles mr JOIN roles ro ON ro.id=mr.role_id WHERE mr.tenant_id=$1 AND mr.user_id=$2`, [r.tenantId, userId])).map((x) => x.role_key)).toEqual(['company_admin']);
  });
  it('rejects bad input and duplicate slugs without leaving a half-made company', async () => {
    const base = { legalName: 'X', adminEmail: 'a@b.test', operatorEmail: 'ops@humantech.test' };
    await expect(createCompany(owner(), pools.system, { ...base, slug: 'Bad Slug' })).rejects.toThrow('slug');
    await expect(createCompany(owner(), pools.system, { ...base, slug: 'okay-slug', adminEmail: 'nope' })).rejects.toThrow('e-mail');
    const slug = `dup-${Date.now().toString(36)}`;
    await createCompany(owner(), pools.system, { ...base, slug });
    await expect(createCompany(owner(), pools.system, { ...base, slug })).rejects.toThrow('already exists');
    expect((await pools.admin.query('SELECT count(*)::int AS n FROM tenants WHERE slug=$1', [slug])).rows[0].n).toBe(1);
  });
  it('sync-roles restores a system role to the code definition', async () => {
    const T = await makeTenant('sync');
    await syncRoles(owner(), T.slug);
    await pools.admin.query(`DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=(SELECT id FROM roles WHERE tenant_id=$1 AND role_key='hr_admin') AND permission_key='audit.read'`, [T.tenantId]).catch(() => undefined);
    await syncRoles(owner(), T.slug);
    const n = (await pools.admin.query(`SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE rp.tenant_id=$1 AND r.role_key='hr_admin' AND rp.permission_key='audit.read'`, [T.tenantId])).rows[0].n;
    expect(n).toBe(1);
    await expect(syncRoles(owner(), 'no-such-co')).rejects.toThrow('No company');
  });
});
