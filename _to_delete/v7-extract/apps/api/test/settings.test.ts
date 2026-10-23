import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let T: Tenant; let U: Tenant;
let e1: string; let cand: string;
const ids: Record<string, string> = {};
type M = 'get' | 'post' | 'put' | 'patch' | 'delete';
const call = async (m: M, sub: string, t: Tenant, path: string, body?: object) => w.h.http()[m](path).set(await w.as(sub, t, { mfa: true })).send(body);
const csv = async (sub: string, t: Tenant, path: string, text: string) => w.h.http().post(path).set(await w.as(sub, t, { mfa: true })).set('Content-Type', 'text/csv').send(text);
const admin = (m: M, p: string, b?: object) => call(m, 'st-admin', T, p, b);
const hr = (m: M, p: string, b?: object) => call(m, 'st-hr', T, p, b);

beforeAll(async () => {
  w = await createWorld();
  T = await w.tenant('st-a', 'sta-root'); U = await w.tenant('st-b', 'stb-root');
  await w.member(T, 'sta-root-boot', 'st-admin', ['company_admin']);
  await w.member(T, 'sta-root-boot', 'st-hr', ['hr_admin']);
  await w.member(T, 'sta-root-boot', 'st-rec', ['recruiter']);
  await w.member(T, 'sta-root-boot', 'st-e1', ['employee'], [T.branch]);
  await w.member(T, 'sta-root-boot', 'st-e2', ['employee'], [T.branch]);
  await w.member(U, 'stb-root-boot', 'st-uadmin', ['company_admin']);
  e1 = await w.employee(T, 'sta-root-boot', 'st-e1', { joined: '2024-01-01', name: 'Asha' });
  await w.employee(T, 'sta-root-boot', 'st-e2', { joined: '2024-01-01', name: 'Bela' });
  const c = await call('post', 'st-rec', T, '/candidates', { firstName: 'Cara', email: 'cara@example.com' });
  cand = c.body.data.id;
});
afterAll(() => w.close());

describe('imports', () => {
  const header = 'first_name,last_name,work_email,branch_code,joined_at\n';
  it('validates first, creates nothing, then commits row by row with a result file', async () => {
    const text = header + 'Ravi,Kumar,ravi@x.in,B1,2025-04-01\nSita,,sita@x.in,B2,2025-04-02\nBad,,not-an-email,B1,2025-04-03\nLost,,lost@x.in,ZZ,2025-04-04\nRavi2,,ravi@x.in,B1,2025-04-05\n';
    const r = await csv('st-hr', T, '/imports/employees', text);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'needs_confirmation', totalRows: 5, acceptedRows: 2, rejectedRows: 3 });
    expect(r.body.data.errors.map((e: { row: number }) => e.row)).toEqual([4, 5, 6]);
    ids.imp = r.body.data.id;
    const before = await w.admin.query(`SELECT count(*)::int AS n FROM employees WHERE tenant_id=$1 AND first_name IN ('Ravi','Sita')`, [T.id]);
    expect(before.rows[0].n).toBe(0);
    expect((await call('get', 'st-e1', T, `/imports/${ids.imp}`)).status).toBe(403);
    expect((await call('get', 'st-admin', T, `/imports/${ids.imp}`)).status).toBe(404);                    // someone else's upload
    const done = await hr('post', `/imports/${ids.imp}/commit`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'completed_with_errors', acceptedRows: 2, rejectedRows: 3, hasResult: true });
    const after = await w.admin.query(`SELECT first_name, employment_status FROM employees WHERE tenant_id=$1 AND first_name IN ('Ravi','Sita') ORDER BY first_name`, [T.id]);
    expect(after.rows).toEqual([{ first_name: 'Ravi', employment_status: 'onboarding' }, { first_name: 'Sita', employment_status: 'onboarding' }]);
    expect((await hr('post', `/imports/${ids.imp}/commit`)).status).toBe(409);                              // only once
    const link = await hr('get', `/imports/${ids.imp}/result`);
    expect(link.body.data.url).toContain('/files/');
    const file = await w.h.http().get(link.body.data.url).set(await w.as('st-hr', T, { mfa: true }));
    expect(file.status).toBe(200); expect(file.text).toContain('created');
    expect((await hr('get', '/imports')).body.data.map((i: { id: string }) => i.id)).toContain(ids.imp);
  });
  it('a re-upload of the same people is rejected, or skipped when asked', async () => {
    const text = header + 'Ravi,Kumar,ravi@x.in,B1,2025-04-01\nNew,,new@x.in,B1,2025-04-06\n';
    const rej = await csv('st-hr', T, '/imports/employees', text);
    expect(rej.body.data).toMatchObject({ acceptedRows: 1, rejectedRows: 1 });
    const skip = await csv('st-hr', T, '/imports/employees?duplicatePolicy=skip', text);
    expect(skip.body.data).toMatchObject({ acceptedRows: 1, rejectedRows: 0, skippedRows: 1 });
    const done = await hr('post', `/imports/${skip.body.data.id}/commit`);
    expect(done.body.data).toMatchObject({ status: 'completed', acceptedRows: 1, skippedRows: 1 });
  });
  it('can be cancelled before confirming and not after', async () => {
    const r = await csv('st-hr', T, '/imports/employees', header + 'Zed,,zed@x.in,B1,2025-04-07\n');
    expect((await hr('post', `/imports/${r.body.data.id}/cancel`)).body.data.status).toBe('cancelled');
    expect((await hr('post', `/imports/${r.body.data.id}/commit`)).status).toBe(409);
    expect((await hr('post', `/imports/${r.body.data.id}/cancel`)).status).toBe(409);
  });
  it('rejects bad files before storing anything', async () => {
    expect((await csv('st-hr', T, '/imports/employees', 'first_name,branch_code,joined_at,surprise\nA,B1,2025-01-01,x\n')).body.error.fields[0].message).toContain('unknown column "surprise"');
    expect((await csv('st-hr', T, '/imports/employees', 'first_name\nA\n')).status).toBe(422);              // missing columns
    expect((await csv('st-hr', T, '/imports/employees', 'first_name,branch_code,joined_at\n')).status).toBe(422);   // no data rows
    expect((await csv('st-hr', T, '/imports/employees', 'first_name,branch_code,joined_at\n"A,B1,2025-01-01\n')).status).toBe(422);   // quote never closes
    expect((await call('post', 'st-hr', T, '/imports/employees', { a: 1 })).status).toBe(415);             // JSON is not a CSV
    expect((await csv('st-hr', T, '/imports/payroll', 'a\n1\n')).status).toBe(404);
    expect((await csv('st-e1', T, '/imports/employees', header)).status).toBe(403);
    const big = 'first_name,branch_code,joined_at\n' + 'A,B1,2025-01-01\n'.repeat(2001);
    expect((await csv('st-hr', T, '/imports/employees', big)).status).toBe(422);
  });
  it('branch scope applies to who may import into a branch', async () => {
    await w.member(T, 'sta-root-boot', 'st-hr1', ['hr_admin'], [T.branch]);
    const r = await csv('st-hr1', T, '/imports/employees', header + 'In,,in@x.in,B1,2025-05-01\nOut,,out@x.in,B2,2025-05-01\n');
    expect(r.body.data).toMatchObject({ acceptedRows: 1, rejectedRows: 1 });
    expect(r.body.data.errors[0].messages[0]).toContain('unknown branch');
  });
  it('imports candidates with phone clean-up and duplicate detection against existing ones', async () => {
    const h = 'first_name,email,phone,city\n';
    const r = await csv('st-rec', T, '/imports/candidates', h + 'Dev,dev@x.in,+91 98765 43210,Pune\nCara,cara@example.com,,Delhi\nNoContact,,,Goa\nDev Again,dev2@x.in,+919876543210,Pune\n');
    expect(r.body.data).toMatchObject({ totalRows: 4, acceptedRows: 1, rejectedRows: 3 });
    // company_admin cannot commit unless it holds import.commit; recruiter does
    const done = await call('post', 'st-rec', T, `/imports/${r.body.data.id}/commit`);
    expect(done.body.data.status).toBe('completed_with_errors');
    const row = await w.admin.query(`SELECT phone_normalized, current_stage FROM candidates WHERE tenant_id=$1 AND email_normalized='dev@x.in'`, [T.id]);
    expect(row.rows[0]).toEqual({ phone_normalized: '+919876543210', current_stage: 'lead_new' });
  });
  it('is invisible to other tenants and audited', async () => {
    expect((await call('get', 'st-uadmin', U, `/imports/${ids.imp}`)).status).toBe(404);
    const a = await w.admin.query(`SELECT action FROM audit_logs WHERE tenant_id=$1 AND action LIKE 'import.%' ORDER BY created_at`, [T.id]);
    expect(a.rows.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['import.validate', 'import.commit', 'import.cancel']));
  });
});

describe('custom fields', () => {
  it('only admins define fields; keys are unique and select fields need options', async () => {
    expect((await hr('post', '/custom-fields', { entityType: 'employee', internalKey: 'blood_group', label: 'Blood group', valueType: 'short_text' })).status).toBe(403);
    const f = await admin('post', '/custom-fields', { entityType: 'employee', internalKey: 'shirt_size', label: 'Shirt size', valueType: 'single_select', options: ['S', 'M', 'L'] });
    expect(f.status).toBe(201); ids.shirt = f.body.data.id;
    expect((await admin('post', '/custom-fields', { entityType: 'employee', internalKey: 'shirt_size', label: 'Again', valueType: 'short_text' })).status).toBe(409);
    expect((await admin('post', '/custom-fields', { entityType: 'employee', internalKey: 'x1', label: 'X', valueType: 'single_select' })).status).toBe(422);
    expect((await admin('post', '/custom-fields', { entityType: 'employee', internalKey: 'x2', label: 'X', valueType: 'number', options: ['a'] })).status).toBe(422);
    expect((await admin('post', '/custom-fields', { entityType: 'client', internalKey: 'x3', label: 'X', valueType: 'number' })).status).toBe(422);
    await admin('post', '/custom-fields', { entityType: 'employee', internalKey: 'pan_hint', label: 'Hint', valueType: 'short_text', required: true });
    await admin('post', '/custom-fields', { entityType: 'employee', internalKey: 'joined_via', label: 'Joined via', valueType: 'multi_select', options: ['agency', 'referral'] });
    await admin('post', '/custom-fields', { entityType: 'employee', internalKey: 'lucky', label: 'Lucky number', valueType: 'number' });
    await admin('post', '/custom-fields', { entityType: 'employee', internalKey: 'anniv', label: 'Anniversary', valueType: 'date' });
    await admin('post', '/custom-fields', { entityType: 'candidate', internalKey: 'portfolio', label: 'Portfolio', valueType: 'url' });
    expect((await admin('get', '/custom-fields?entityType=employee')).body.data).toHaveLength(5);
    expect((await admin('get', '/custom-fields?entityType=candidate')).body.data).toHaveLength(1);
  });
  it('values are checked by type and by who may edit the record', async () => {
    const put = (sub: string, p: string, values: object) => call('put', sub, T, p, { values });
    const ok = await put('st-hr', `/employees/${e1}/custom-values`, { shirt_size: 'M', pan_hint: 'on file', joined_via: ['referral'], lucky: 7, anniv: '2023-02-28' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.find((f: { internalKey: string }) => f.internalKey === 'shirt_size').value).toBe('M');
    for (const bad of [{ shirt_size: 'XXL' }, { lucky: '7' }, { anniv: '2023-02-30' }, { joined_via: ['agency', 'agency'] }, { pan_hint: null }, { nope: 'x' }, { shirt_size: 5 }]) {
      expect((await put('st-hr', `/employees/${e1}/custom-values`, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await put('st-hr', `/employees/${e1}/custom-values`, {})).status).toBe(422);
    expect((await put('st-e1', `/employees/${e1}/custom-values`, { shirt_size: 'S' })).status).toBe(403);   // cannot edit own
    expect((await call('get', 'st-e1', T, `/employees/${e1}/custom-values`)).body.data.find((f: { internalKey: string }) => f.internalKey === 'shirt_size').value).toBe('M');   // can read own
    expect((await call('get', 'st-e2', T, `/employees/${e1}/custom-values`)).status).toBe(403);   // peers have no read access
    expect((await call('get', 'st-uadmin', U, `/employees/${e1}/custom-values`)).status).toBe(404);
    expect((await put('st-hr', `/things/${e1}/custom-values`, { a: 1 })).status).toBe(404);
    const c = await put('st-rec', `/candidates/${cand}/custom-values`, { portfolio: 'https://example.com/me' });
    expect(c.status).toBe(200);
    expect((await put('st-rec', `/candidates/${cand}/custom-values`, { portfolio: 'javascript:alert(1)' })).status).toBe(422);
    expect((await put('st-rec', `/candidates/${cand}/custom-values`, { shirt_size: 'M' })).status).toBe(422);   // an employee field
    expect((await put('st-e1', `/candidates/${cand}/custom-values`, { portfolio: 'https://a.b' })).status).toBe(403);
  });
  it('deactivated fields stop accepting values but keep what was stored; required stays required', async () => {
    expect((await admin('patch', `/custom-fields/${ids.shirt}`, { options: ['S', 'M', 'L', 'XL'] })).body.data.options).toContain('XL');
    expect((await admin('patch', `/custom-fields/${ids.shirt}`, { active: false })).body.data.active).toBe(false);
    expect((await call('put', 'st-hr', T, `/employees/${e1}/custom-values`, { values: { shirt_size: 'L' } })).status).toBe(422);
    expect((await call('get', 'st-hr', T, `/employees/${e1}/custom-values`)).body.data.find((f: { internalKey: string }) => f.internalKey === 'shirt_size').value).toBe('M');
    expect((await admin('patch', `/custom-fields/${ids.shirt}`, { options: ['a'] })).status).toBe(200);
    expect((await admin('patch', `/custom-fields/${ids.shirt}`, {})).status).toBe(422);
    expect((await call('patch', 'st-uadmin', U, `/custom-fields/${ids.shirt}`, { label: 'Hijack' })).status).toBe(404);
  });
});

describe('saved views', () => {
  it('private by default, validated against the list, shared only by those allowed', async () => {
    const mk = (sub: string, b: object) => call('post', sub, T, '/views', b);
    const v = await mk('st-e1', { entityType: 'employees', name: 'Active in B1', config: { columns: ['name', 'status'], filters: { status: 'active' }, sort: { key: 'name', direction: 'asc' } } });
    expect(v.status).toBe(201); ids.v1 = v.body.data.id;
    expect((await mk('st-e1', { entityType: 'employees', name: 'Active in B1', config: {} })).status).toBe(409);
    expect((await mk('st-e1', { entityType: 'employees', name: 'x', config: { columns: ['salary'] } })).status).toBe(422);
    expect((await mk('st-e1', { entityType: 'employees', name: 'x', config: { filters: { password: '1' } } })).status).toBe(422);
    expect((await mk('st-e1', { entityType: 'employees', name: 'x', config: { sort: { key: 'ctc', direction: 'asc' } } })).status).toBe(422);
    expect((await mk('st-e1', { entityType: 'payslips', name: 'x', config: {} })).status).toBe(422);
    expect((await mk('st-e1', { entityType: 'employees', name: 'Everyone', config: {}, shared: true })).status).toBe(403);
    expect((await call('get', 'st-e2', T, '/views')).body.data).toEqual([]);
    expect((await mk('st-hr', { entityType: 'employees', name: 'Company view', config: {}, shared: true })).status).toBe(403);   // HR cannot share company-wide
    const s = await mk('st-admin', { entityType: 'employees', name: 'Company view', config: { columns: ['name'] }, shared: true });
    expect(s.status).toBe(201); ids.vs = s.body.data.id;
    const seen = (await call('get', 'st-e2', T, '/views?entityType=employees')).body.data;
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ name: 'Company view', shared: true, mine: false });
    expect((await call('get', 'st-uadmin', U, '/views')).body.data).toEqual([]);
  });
  it('edit and delete: owner, or someone who manages shared views', async () => {
    expect((await call('patch', 'st-e2', T, `/views/${ids.v1}`, { name: 'mine now' })).status).toBe(404);   // private to someone else
    expect((await call('patch', 'st-e2', T, `/views/${ids.vs}`, { name: 'hijack' })).status).toBe(403);
    expect((await call('delete', 'st-e2', T, `/views/${ids.vs}`)).status).toBe(403);
    expect((await call('patch', 'st-e1', T, `/views/${ids.v1}`, { name: 'Renamed', shared: true })).status).toBe(403);
    expect((await call('patch', 'st-e1', T, `/views/${ids.v1}`, { name: 'Renamed' })).body.data.name).toBe('Renamed');
    expect((await call('patch', 'st-admin', T, `/views/${ids.vs}`, { name: 'Company view v2' })).body.data.name).toBe('Company view v2');
    expect((await call('patch', 'st-hr', T, `/views/${ids.vs}`, { name: 'x' })).status).toBe(403);
    expect((await call('delete', 'st-e1', T, `/views/${ids.v1}`)).status).toBe(204);
    expect((await call('delete', 'st-e1', T, `/views/${ids.v1}`)).status).toBe(404);
  });
});

describe('privacy requests and retention', () => {
  it('employees file for themselves; HR handles them through a fixed path', async () => {
    const r = await call('post', 'st-e1', T, '/privacy-requests', { requestType: 'access', details: 'Please send me my data' });
    expect(r.status).toBe(201); ids.pr = r.body.data.id;
    expect(r.body.data).toMatchObject({ status: 'received', subjectEmployeeId: e1 });
    const due = new Date(r.body.data.dueAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(29 * 86400_000); expect(due).toBeLessThan(31 * 86400_000);
    expect((await call('post', 'st-e1', T, '/privacy-requests', { requestType: 'erasure', subjectEmployeeId: (await w.admin.query(`SELECT id FROM employees WHERE tenant_id=$1 AND user_id=$2`, [T.id, w.users['st-e2']])).rows[0].id })).status).toBe(404);
    expect((await call('post', 'st-e1', T, '/privacy-requests', { requestType: 'access', subjectCandidateId: cand })).status).toBe(403);
    expect((await call('get', 'st-e1', T, '/privacy-requests')).body.data).toHaveLength(1);
    expect((await call('get', 'st-e2', T, '/privacy-requests')).body.data).toEqual([]);
    expect((await hr('get', '/privacy-requests')).body.data.length).toBeGreaterThanOrEqual(1);
    expect((await call('post', 'st-e1', T, `/privacy-requests/${ids.pr}/status`, { status: 'in_progress' })).status).toBe(403);
    expect((await hr('post', `/privacy-requests/${ids.pr}/status`, { status: 'completed', resolutionNote: 'x' })).status).toBe(409);   // must go through in_progress
    expect((await hr('post', `/privacy-requests/${ids.pr}/status`, { status: 'in_progress' })).body.data.status).toBe('in_progress');
    expect((await hr('post', `/privacy-requests/${ids.pr}/status`, { status: 'completed' })).status).toBe(422);                  // needs an explanation
    const done = await hr('post', `/privacy-requests/${ids.pr}/status`, { status: 'completed', resolutionNote: 'Sent by email' });
    expect(done.body.data).toMatchObject({ status: 'completed', resolutionNote: 'Sent by email' }); expect(done.body.data.completedAt).toBeTruthy();
    expect((await hr('post', `/privacy-requests/${ids.pr}/status`, { status: 'rejected', resolutionNote: 'no' })).status).toBe(409);
    expect((await call('get', 'st-uadmin', U, '/privacy-requests')).body.data).toEqual([]);
  });
  it('HR can file on behalf of a candidate', async () => {
    const r = await hr('post', '/privacy-requests', { requestType: 'erasure', subjectCandidateId: cand });
    expect(r.status).toBe(201); expect(r.body.data.subjectCandidateId).toBe(cand);
    expect((await hr('post', '/privacy-requests', { requestType: 'erasure', subjectCandidateId: cand, subjectEmployeeId: e1 })).status).toBe(422);
  });
  it('retention policies are set by privacy managers and replace the earlier value', async () => {
    expect((await call('get', 'st-e1', T, '/retention-policies')).status).toBe(403);
    expect((await hr('put', '/retention-policies', { entityType: 'candidate', retainMonths: 24, actionAfter: 'anonymise', legalBasis: 'Consent window' })).body.data.retainMonths).toBe(24);
    await hr('put', '/retention-policies', { entityType: 'candidate', retainMonths: 12, actionAfter: 'delete' });
    const list = (await hr('get', '/retention-policies')).body.data;
    expect(list).toEqual([{ entityType: 'candidate', retainMonths: 12, actionAfter: 'delete', legalBasis: null }]);
    expect((await hr('put', '/retention-policies', { entityType: 'candidate', retainMonths: 0, actionAfter: 'delete' })).status).toBe(422);
    expect((await hr('put', '/retention-policies', { entityType: 'payroll_runs', retainMonths: 12, actionAfter: 'delete' })).status).toBe(422);
    expect((await call('get', 'st-uadmin', U, '/retention-policies')).body.data).toEqual([]);
  });
});

describe('billing', () => {
  it('shows plan, usage and invoices read-only, per company', async () => {
    const plan = (await w.admin.query(`INSERT INTO plans (code, name, max_active_employees, max_branches, monthly_price) VALUES ('st-grow','Grow',50,3,'4999.00') RETURNING id`)).rows[0].id;
    await w.admin.query(`INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_end) VALUES ($1,$2,'active','2026-12-31')`, [T.id, plan]);
    await w.admin.query(`INSERT INTO saas_invoices (tenant_id, invoice_number, period_start, period_end, amount, status) VALUES ($1,'SAAS-ST-1','2026-10-01','2026-10-31','4999.00','issued')`, [T.id]);
    await w.admin.query(`INSERT INTO saas_invoices (tenant_id, invoice_number, period_start, period_end, amount, status) VALUES ($1,'SAAS-ST-0','2026-09-01','2026-09-30','4999.00','draft')`, [T.id]);
    const b = (await admin('get', '/billing')).body.data;
    expect(b.plan).toMatchObject({ code: 'st-grow', maxActiveEmployees: 50, monthlyPrice: '4999.00', currency: 'INR' });
    expect(b.subscription).toMatchObject({ status: 'active', currentPeriodEnd: '2026-12-31', employeeLimit: 50 });
    expect(b.usage.branches).toBe(2); expect(b.usage.activeEmployees).toBeGreaterThanOrEqual(2);
    expect(b.invoices).toEqual([expect.objectContaining({ invoiceNumber: 'SAAS-ST-1', periodStart: '2026-10-01', amount: '4999.00', status: 'issued' })]);
    expect((await call('get', 'st-uadmin', U, '/billing')).body.data).toMatchObject({ plan: null, subscription: null, invoices: [] });
    expect((await hr('get', '/billing')).status).toBe(403);
    expect((await admin('post', '/billing', {})).status).toBe(404);
  });
});
