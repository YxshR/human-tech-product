import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let X: Tenant; let Y: Tenant; let e1: string; let e2: string; let hrEmp: string; let newHire: string; let leaver: string;
const ids: Record<string, string> = {};
type M = 'get' | 'post' | 'patch' | 'put' | 'delete';
const call = async (m: M, sub: string, t: Tenant, path: string, body?: object) => w.h.http()[m](path).set(await w.as(sub, t, { mfa: true })).send(body);
const hr = (m: M, p: string, b?: object) => call(m, 'ex-hr', X, p, b);
const fin = (m: M, p: string, b?: object) => call(m, 'ex-fin', X, p, b);
const appr = (m: M, p: string, b?: object) => call(m, 'ex-appr', X, p, b);
const pdf = (n = 200) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n, 0x61)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let today = '';

beforeAll(async () => {
  w = await createWorld();
  X = await w.tenant('ex-a', 'exa-root'); Y = await w.tenant('ex-b', 'exb-root');
  await w.member(X, 'exa-root-boot', 'ex-hr', ['hr_admin']);
  await w.member(X, 'exa-root-boot', 'ex-fin', ['finance_payroll']);
  await w.member(X, 'exa-root-boot', 'ex-appr', ['payroll_approver']);
  await w.member(X, 'exa-root-boot', 'ex-both', ['finance_payroll', 'payroll_approver']);
  await w.member(X, 'exa-root-boot', 'ex-e1', ['employee'], [X.branch]);
  await w.member(X, 'exa-root-boot', 'ex-e2', ['employee'], [X.branch]);
  await w.member(X, 'exa-root-boot', 'ex-leaver', ['employee'], [X.branch]);
  await w.member(Y, 'exb-root-boot', 'ex-yhr', ['hr_admin']);
  e1 = await w.employee(X, 'exa-root-boot', 'ex-e1', { joined: '2024-01-01', name: 'Asha' });
  e2 = await w.employee(X, 'exa-root-boot', 'ex-e2', { joined: '2024-01-01', name: 'Bala' });
  leaver = await w.employee(X, 'exa-root-boot', 'ex-leaver', { joined: '2024-01-01', name: 'Leela' });
  hrEmp = await w.employee(X, 'exa-root-boot', null, { joined: '2024-01-01', name: 'Hari' });
  newHire = await w.employee(X, 'exa-root-boot', null, { joined: '2026-10-01', name: 'Nila', status: 'onboarding' });
  today = (await w.admin.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') d`)).rows[0].d;
});
afterAll(() => w.close());

describe('personal details & emergency contacts', () => {
  const addr = { line1: '12 MG Road', city: 'Bengaluru', state: 'KA', postalCode: '560001' };
  it('HR writes, the employee reads their own, colleagues cannot', async () => {
    const put = await hr('put', `/employees/${e1}/personal`, { dateOfBirth: '1990-05-17', gender: 'female', maritalStatus: 'single', nationality: 'Indian', currentAddress: addr });
    expect(put.status).toBe(200); expect(put.body.data.currentAddress).toMatchObject({ city: 'Bengaluru', country: 'IN' });
    expect((await call('get', 'ex-e1', X, `/employees/${e1}/personal`)).body.data.dateOfBirth).toBe('1990-05-17');
    expect((await call('get', 'ex-e2', X, `/employees/${e1}/personal`)).status).toBe(403);
    expect((await call('put', 'ex-e1', X, `/employees/${e1}/personal`, { gender: 'male' })).status).toBe(403);
    expect((await hr('put', `/employees/${e1}/personal`, { maritalStatus: 'married' })).body.data).toMatchObject({ maritalStatus: 'married', dateOfBirth: '1990-05-17' });
    expect((await hr('put', `/employees/${e1}/personal`, { currentAddress: null })).body.data.currentAddress).toEqual({});
    expect((await hr('put', `/employees/${e1}/personal`, { dateOfBirth: '2020-01-01' })).status).toBe(422);
    expect((await hr('put', `/employees/${e1}/personal`, {})).status).toBe(422);
    expect((await hr('put', `/employees/${e1}/personal`, { nope: 1 })).status).toBe(422);
    const a = (await w.admin.query(`SELECT after_redacted FROM audit_logs WHERE tenant_id=$1 AND action='employee.personal_update' ORDER BY created_at DESC LIMIT 1`, [X.id])).rows[0].after_redacted;
    expect(JSON.stringify(a)).not.toMatch(/1990|Bengaluru|married/);
  });
  it('emergency contacts', async () => {
    const add = (n: number) => hr('post', `/employees/${e1}/emergency-contacts`, { name: `Contact ${n}`, relationship: 'Sibling', phone: '+91 98765 43210' });
    const first = await add(1); expect(first.status).toBe(201);
    expect((await hr('post', `/employees/${e1}/emergency-contacts`, { name: 'x', relationship: 'y', phone: 'abc' })).status).toBe(422);
    for (let i = 2; i <= 5; i++) expect((await add(i)).status).toBe(201);
    expect((await add(6)).status).toBe(409);
    expect((await call('get', 'ex-e1', X, `/employees/${e1}/emergency-contacts`)).body.data).toHaveLength(5);
    expect((await hr('delete', `/employees/${e1}/emergency-contacts/${first.body.data.id}`)).status).toBe(204);
    expect((await hr('delete', `/employees/${e1}/emergency-contacts/${first.body.data.id}`)).status).toBe(404);
  });
});

describe('statutory identifiers', () => {
  it('are validated, encrypted at rest and only ever shown masked', async () => {
    const r = await hr('put', `/employees/${e1}/identifiers/pan`, { value: ' abcde 1234-f ' });
    expect(r.status).toBe(200); expect(r.body.data).toMatchObject({ type: 'pan', masked: '••••••234F', verifiedAt: null });
    const row = (await w.admin.query(`SELECT value_ciphertext, value_last4, blind_index FROM employee_identifiers WHERE employee_id=$1 AND superseded_at IS NULL`, [e1])).rows[0];
    expect(row.value_ciphertext.toString('latin1')).not.toContain('ABCDE'); expect(row.value_last4).toBe('234F'); expect(row.blind_index).toBeTruthy();
    expect((await hr('put', `/employees/${e1}/identifiers/pan`, { value: 'BADPAN' })).status).toBe(422);
    expect((await hr('put', `/employees/${e1}/identifiers/aadhaar`, { value: '123412341234' })).status).toBe(404);
    expect((await hr('put', `/employees/${e1}/identifiers/uan`, { value: '1234567890' })).status).toBe(422);
    expect((await hr('put', `/employees/${e1}/identifiers/uan`, { value: '100200300400' })).status).toBe(200);
    expect((await hr('put', `/employees/${e2}/identifiers/pan`, { value: 'ABCDE1234F' })).status).toBe(409);        // duplicate (blind index)
    const list = await fin('get', `/employees/${e1}/identifiers`);
    expect(list.body.data.map((x: { type: string }) => x.type)).toEqual(['pan', 'uan']); expect(JSON.stringify(list.body)).not.toMatch(/ABCDE1234F|100200300400/);
    expect((await call('get', 'ex-e1', X, `/employees/${e1}/identifiers`)).status).toBe(200);
    expect((await call('get', 'ex-e2', X, `/employees/${e1}/identifiers`)).status).toBe(403);
    expect((await appr('post', `/employees/${e1}/identifiers/pan/verify`)).body.data.verifiedAt).toBeTruthy();
    expect((await appr('post', `/employees/${e1}/identifiers/pan/verify`)).status).toBe(409);
    // changing the value supersedes the old row and clears verification
    expect((await hr('put', `/employees/${e1}/identifiers/pan`, { value: 'ZZZZZ9999Z' })).body.data.verifiedAt).toBeNull();
    expect((await w.admin.query(`SELECT count(*)::int n FROM employee_identifiers WHERE employee_id=$1 AND identifier_type='pan'`, [e1])).rows[0].n).toBe(2);
    expect((await hr('put', `/employees/${e2}/identifiers/pan`, { value: 'ABCDE1234F' })).status).toBe(200);          // the old value is free again
  });
});

describe('bank details (encrypted, maker-checker)', () => {
  const body = (o: object = {}) => ({ accountHolderName: 'Asha Rao', accountNumber: '123456789012', ifsc: 'hdfc0001234', bankName: 'HDFC Bank', effectiveFrom: today, ...o });
  it('proposed by one person, verified by another', async () => {
    const p = await fin('post', `/employees/${e1}/bank`, body());
    expect(p.status).toBe(201); expect(p.body.data).toMatchObject({ status: 'pending_verification', accountNumberMasked: '••••••9012', ifsc: 'HDFC0001234' }); ids.bank1 = p.body.data.id;
    const raw = (await w.admin.query(`SELECT account_number_ciphertext, ifsc_ciphertext FROM employee_bank_details WHERE id=$1`, [ids.bank1])).rows[0];
    expect(raw.account_number_ciphertext.toString('latin1')).not.toContain('123456789012'); expect(raw.ifsc_ciphertext.toString('latin1')).not.toContain('HDFC');
    expect(JSON.stringify(p.body)).not.toContain('123456789012');
    expect((await fin('post', `/employees/${e1}/bank`, body())).status).toBe(409);
    expect((await fin('post', `/employees/${e2}/bank`, body({ accountNumber: '12345', effectiveFrom: today }))).status).toBe(422);
    expect((await fin('post', `/employees/${e2}/bank`, body({ effectiveFrom: '2020-01-01' }))).status).toBe(422);
    expect((await hr('post', `/employees/${e1}/bank`, body())).status).toBe(403);
    expect((await fin('post', `/bank-details/${ids.bank1}/verify`, {})).status).toBe(403);
    const both = await call('post', 'ex-both', X, `/employees/${e2}/bank`, body({ accountNumber: '999988887777' }));
    expect((await call('post', 'ex-both', X, `/bank-details/${both.body.data.id}/verify`, {})).body.error.code).toBe('maker_checker_violation');
    expect((await appr('post', `/bank-details/${ids.bank1}/verify`, { comment: 'checked cancelled cheque' })).body.data).toMatchObject({ status: 'verified' });
    expect((await appr('post', `/bank-details/${ids.bank1}/verify`, {})).status).toBe(409);
  });
  it('who can see it', async () => {
    expect((await call('get', 'ex-e1', X, `/employees/${e1}/bank`)).body.data[0].accountNumberMasked).toBe('••••••9012');
    expect((await call('get', 'ex-e2', X, `/employees/${e1}/bank`)).status).toBe(403);
    expect((await hr('get', `/employees/${e1}/bank`)).status).toBe(403);
    expect((await call('get', 'ex-yhr', Y, `/employees/${e1}/bank`)).status).toBe(404);   // other tenant: the employee does not exist
  });
  it('a replacement must start later, closes the old record, and rejection restores it', async () => {
    const later = (await w.admin.query(`SELECT to_char($1::date + 10,'YYYY-MM-DD') d`, [today])).rows[0].d;
    expect((await fin('post', `/employees/${e1}/bank`, body({ effectiveFrom: today, accountNumber: '555566667777' }))).status).toBe(422);
    const n = await fin('post', `/employees/${e1}/bank`, body({ effectiveFrom: later, accountNumber: '555566667777', bankName: 'ICICI' })); expect(n.status).toBe(201);
    const open = (await fin('get', `/employees/${e1}/bank`)).body.data;
    expect(open.find((x: { id: string }) => x.id === ids.bank1).effectiveTo).not.toBeNull();
    expect((await call('post', 'ex-both', X, `/bank-details/${n.body.data.id}/withdraw`)).status).toBe(403);       // only the proposer may withdraw
    expect((await appr('post', `/bank-details/${n.body.data.id}/reject`, { comment: 'cheque unreadable' })).body.data.status).toBe('rejected');
    expect((await fin('get', `/employees/${e1}/bank`)).body.data.find((x: { id: string }) => x.id === ids.bank1).effectiveTo).toBeNull();
    const again = await fin('post', `/employees/${e1}/bank`, body({ effectiveFrom: later, accountNumber: '555566667777' }));
    expect((await fin('post', `/bank-details/${again.body.data.id}/withdraw`)).body.data.status).toBe('rejected');
    expect((await fin('get', `/employees/${e1}/bank`)).body.data.find((x: { id: string }) => x.id === ids.bank1).effectiveTo).toBeNull();
  });
});

describe('profile change requests', () => {
  it('employee asks, HR decides, nobody reviews their own', async () => {
    const r = await call('post', 'ex-e1', X, '/profile-changes', { changes: { phone: '+91 90000 11111', maritalStatus: 'married', currentAddress: { line1: '5 Park St', city: 'Kolkata', state: 'WB', postalCode: '700016' } } });
    expect(r.status).toBe(201); ids.pc = r.body.data.id;
    expect((await call('post', 'ex-e1', X, '/profile-changes', { changes: { phone: '+91 90000 22222' } })).status).toBe(409);
    expect((await call('post', 'ex-e1', X, '/profile-changes', { changes: { salary: 1 } })).status).toBe(422);
    expect((await call('post', 'ex-e1', X, `/profile-changes/${ids.pc}/approve`, {})).status).toBe(403);
    expect((await call('get', 'ex-e2', X, '/profile-changes')).body.data).toEqual([]);
    expect((await call('get', 'ex-e1', X, '/profile-changes')).body.data).toHaveLength(1);
    expect((await hr('get', '/profile-changes?status=pending')).body.data).toHaveLength(1);
    expect((await hr('post', `/profile-changes/${ids.pc}/approve`, { comment: 'ok' })).body.data.status).toBe('approved');
    expect((await w.admin.query(`SELECT phone FROM employees WHERE id=$1`, [e1])).rows[0].phone).toBe('+91 90000 11111');
    expect((await call('get', 'ex-e1', X, `/employees/${e1}/personal`)).body.data).toMatchObject({ maritalStatus: 'married', currentAddress: { city: 'Kolkata' } });
    expect((await hr('post', `/profile-changes/${ids.pc}/approve`, {})).status).toBe(409);
    const r2 = await call('post', 'ex-e1', X, '/profile-changes', { changes: { phone: '+91 90000 33333' } });
    expect((await hr('post', `/profile-changes/${r2.body.data.id}/reject`, { comment: 'not verified' })).body.data.status).toBe('rejected');
    const r3 = await call('post', 'ex-e1', X, '/profile-changes', { changes: { phone: '+91 90000 44444' } });
    expect((await call('post', 'ex-e2', X, `/profile-changes/${r3.body.data.id}/cancel`)).status).toBe(404);
    expect((await call('post', 'ex-e1', X, `/profile-changes/${r3.body.data.id}/cancel`)).body.data.status).toBe('cancelled');
  });
});

describe('documents', () => {
  it('declare, upload with integrity checks, download via short-lived signed link', async () => {
    const data = pdf(); const decl = { documentType: 'id_proof', title: 'Passport', filename: 'passport.pdf', contentType: 'application/pdf', sizeBytes: data.length, sha256: sha(data) };
    const d = await hr('post', `/employees/${e1}/documents`, decl);
    expect(d.status).toBe(201); const path = d.body.data.upload.path; ids.doc = d.body.data.document.id; ids.file = path.split('/')[2];
    const put = async (b: Buffer, ct = 'application/pdf', sub = 'ex-hr') => w.h.http().put(path).set(await w.as(sub, X, { mfa: true })).set('Content-Type', ct).send(b);
    expect((await put(data, 'image/png')).status).toBe(415);
    expect((await put(Buffer.concat([data, Buffer.from('x')]))).status).toBe(422);
    expect((await put(Buffer.alloc(data.length, 0x62))).status).toBe(422);                               // checksum mismatch
    expect((await put(data, 'application/pdf', 'ex-e1')).status).toBe(403);
    const ok = await put(data); expect(ok.status).toBe(200); expect(ok.body.data.status).toBe('clean');
    expect((await put(data)).status).toBe(409);

    const list = await call('get', 'ex-e1', X, `/employees/${e1}/documents`); expect(list.body.data).toHaveLength(1);
    expect((await call('get', 'ex-e2', X, `/employees/${e1}/documents`)).status).toBe(403);
    const link = await call('get', 'ex-e1', X, `/documents/${ids.doc}/download-link`);
    const dl = await w.h.http().get(link.body.data.url).set(await w.as('ex-e1', X)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(dl.status).toBe(200); expect(dl.headers['content-type']).toBe('application/pdf'); expect((dl.body as Buffer).equals(data)).toBe(true);
    expect((await w.h.http().get(link.body.data.url).set(await w.as('ex-hr', X))).status).toBe(404);   // link is bound to the person it was issued to
    expect((await w.h.http().get(link.body.data.url.replace(/sig=.{4}/, 'sig=AAAA')).set(await w.as('ex-e1', X))).status).toBe(404);
    expect((await w.h.http().get(`/files/${ids.file}/download?exp=1&sig=x`).set(await w.as('ex-e1', X))).status).toBe(404);
    const ev = (await w.admin.query(`SELECT action FROM file_access_events WHERE file_id=$1 ORDER BY created_at`, [ids.file])).rows.map((r) => r.action);
    expect(ev).toEqual(['upload', 'download_url_issued', 'download']);
    expect(await w.h.http().get(`/documents/${ids.doc}/download-link`).set(await w.as('ex-yhr', Y)).then((r) => r.status)).toBe(404);
  });
  it('rejects bad declarations and enforces permissions', async () => {
    const base = { documentType: 'id_proof', filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 100, sha256: sha(Buffer.from('x')) };
    expect((await hr('post', `/employees/${e1}/documents`, { ...base, contentType: 'text/html' })).status).toBe(422);
    expect((await hr('post', `/employees/${e1}/documents`, { ...base, filename: '../../etc/passwd' })).status).toBe(422);
    expect((await hr('post', `/employees/${e1}/documents`, { ...base, sizeBytes: 11 * 1024 * 1024 })).status).toBe(413);
    expect((await call('post', 'ex-e1', X, `/employees/${e1}/documents`, base)).status).toBe(403);
    const fake = Buffer.from('<html>not a pdf</html>');
    const d = await hr('post', `/employees/${e1}/documents`, { ...base, sizeBytes: fake.length, sha256: sha(fake) });
    const r = await w.h.http().put(d.body.data.upload.path).set(await w.as('ex-hr', X, { mfa: true })).set('Content-Type', 'application/pdf').send(fake);
    expect(r.status).toBe(415);
  });
  it('verify and delete', async () => {
    expect((await hr('post', `/documents/${ids.doc}/verify`)).body.data.verifiedAt).toBeTruthy();
    expect((await call('delete', 'ex-e1', X, `/documents/${ids.doc}`)).status).toBe(403);
    expect((await hr('delete', `/documents/${ids.doc}`)).status).toBe(204);
    expect((await hr('get', `/employees/${e1}/documents`)).body.data.map((x: { id: string }) => x.id)).not.toContain(ids.doc);
    expect((await w.admin.query(`SELECT status FROM stored_files WHERE id=$1`, [ids.file])).rows[0].status).toBe('deleted');
  });
});

describe('onboarding', () => {
  it('templates become dated tasks; activation waits for required ones', async () => {
    const t1 = await hr('post', '/onboarding/templates', { code: 'LAPTOP', title: 'Issue laptop', dueOffsetDays: 1, displayOrder: 1 });
    expect(t1.status).toBe(201);
    await hr('post', '/onboarding/templates', { code: 'WELCOME', title: 'Welcome email', dueOffsetDays: 0, required: false, displayOrder: 2 });
    await hr('post', '/onboarding/templates', { code: 'CLEARANCE', phase: 'offboarding', title: 'Return assets', dueOffsetDays: 0 });
    expect((await hr('post', '/onboarding/templates', { code: 'laptop', title: 'Dup' })).status).toBe(409);
    const tasks = (await hr('post', `/employees/${newHire}/onboarding/instantiate`, {})).body.data;
    expect(tasks.map((t: { title: string; dueDate: string }) => `${t.title}@${t.dueDate}`)).toEqual(['Welcome email@2026-10-01', 'Issue laptop@2026-10-02']);
    expect((await hr('post', `/employees/${newHire}/onboarding/instantiate`, {})).body.data).toHaveLength(2);   // idempotent
    expect((await hr('post', `/employees/${newHire}/onboarding/complete`, {})).status).toBe(409);
    const laptop = tasks.find((t: { title: string }) => t.title === 'Issue laptop');
    expect((await hr('patch', `/onboarding/tasks/${laptop.id}`, { status: 'waived' })).status).toBe(422);
    expect((await hr('patch', `/onboarding/tasks/${laptop.id}`, { status: 'waived', waiverReason: 'Bring your own device' })).body.data).toMatchObject({ status: 'waived' });
    expect((await call('patch', 'ex-e2', X, `/onboarding/tasks/${laptop.id}`, { status: 'done' })).status).toBe(404);
    const c = await hr('post', `/employees/${newHire}/onboarding/complete`, { employmentStatus: 'probation' });
    expect(c.body.data.employmentStatus).toBe('probation');
    expect((await hr('post', `/employees/${newHire}/onboarding/complete`, {})).status).toBe(409);
  });
  it('owners can complete their own tasks', async () => {
    const t = (await hr('post', `/employees/${e2}/onboarding/tasks`, { title: 'Sign policy handbook', required: true })).body.data;
    expect((await call('patch', 'ex-e2', X, `/onboarding/tasks/${t.id}`, { status: 'done' })).status).toBe(404);
    expect((await hr('patch', `/onboarding/tasks/${t.id}`, { status: 'pending', ownerUserId: w.users['ex-e2'] })).body.data.ownerUserId).toBe(w.users['ex-e2']);
    expect((await hr('patch', `/onboarding/tasks/${t.id}`, { status: 'pending', ownerUserId: w.users['ex-yhr'] })).status).toBe(422);
    expect((await call('get', 'ex-e2', X, '/onboarding/my-tasks')).body.data.map((x: { id: string }) => x.id)).toContain(t.id);
    const done = await call('patch', 'ex-e2', X, `/onboarding/tasks/${t.id}`, { status: 'done' });
    expect(done.body.data).toMatchObject({ status: 'done', completedBy: w.users['ex-e2'] });
    expect((await call('patch', 'ex-e2', X, `/onboarding/tasks/${t.id}`, { status: 'waived', waiverReason: 'self waive attempt' })).status).toBe(403);
  });
});

describe('exits', () => {
  it('walks the offboarding flow and revokes access at completion', async () => {
    const x = await hr('post', `/employees/${leaver}/exit`, { resignationDate: '2026-10-10', lastWorkingDate: '2026-10-31', reasonCode: 'better_opportunity' });
    expect(x.status).toBe(201); ids.exit = x.body.data.id;
    expect((await hr('post', `/employees/${leaver}/exit`, { lastWorkingDate: '2026-11-30' })).status).toBe(409);
    expect((await w.admin.query(`SELECT employment_status, to_char(last_working_date,'YYYY-MM-DD') l FROM employees WHERE id=$1`, [leaver])).rows[0]).toEqual({ employment_status: 'on_notice', l: '2026-10-31' });
    const tasks = (await call('get', 'ex-leaver', X, `/employees/${leaver}/onboarding`)).body.data;
    expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ phase: 'offboarding', title: 'Return assets', dueDate: '2026-10-31' });
    expect((await hr('patch', `/exits/${ids.exit}`, { status: 'completed' })).status).toBe(409);                     // not a legal jump
    expect((await hr('patch', `/exits/${ids.exit}`, { status: 'clearance' })).body.data.status).toBe('clearance');
    expect((await hr('patch', `/exits/${ids.exit}`, { status: 'settlement_pending' })).body.data.status).toBe('settlement_pending');
    const done = await hr('patch', `/exits/${ids.exit}`, { status: 'completed', finalSettlementStatus: 'paid' });
    expect(done.status).toBe(409); expect(done.body.error.message).toMatch(/offboarding task/);
    await hr('patch', `/onboarding/tasks/${tasks[0].id}`, { status: 'done' });
    expect((await hr('patch', `/exits/${ids.exit}`, { status: 'completed' })).status).toBe(409);                      // settlement still not recorded
    const ok = await hr('patch', `/exits/${ids.exit}`, { status: 'completed', finalSettlementStatus: 'paid' });
    expect(ok.status).toBe(200); expect(ok.body.data.accessRevokedAt).toBeTruthy();
    expect((await w.admin.query(`SELECT employment_status, to_char(exited_at,'YYYY-MM-DD') x FROM employees WHERE id=$1`, [leaver])).rows[0]).toEqual({ employment_status: 'exited', x: '2026-10-31' });
    expect((await w.admin.query(`SELECT status FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`, [X.id, w.users['ex-leaver']])).rows[0].status).toBe('suspended');
    expect((await hr('patch', `/exits/${ids.exit}`, { reasonNotes: 'late edit' })).status).toBe(409);
  });
  it('a cancelled exit returns the employee to active', async () => {
    const x = await hr('post', `/employees/${hrEmp}/exit`, { lastWorkingDate: '2026-12-31', createTasks: false });
    expect(x.status).toBe(201);
    expect((await hr('post', `/employees/${hrEmp}/exit`, { lastWorkingDate: '2027-01-31' })).status).toBe(409);
    expect((await hr('patch', `/exits/${x.body.data.id}`, { status: 'cancelled' })).body.data.status).toBe('cancelled');
    expect((await w.admin.query(`SELECT employment_status, last_working_date FROM employees WHERE id=$1`, [hrEmp])).rows[0]).toEqual({ employment_status: 'active', last_working_date: null });
    expect((await hr('post', `/employees/${hrEmp}/exit`, { lastWorkingDate: '2020-01-01' })).status).toBe(422);
    expect((await call('post', 'ex-e1', X, `/employees/${e1}/exit`, { lastWorkingDate: '2026-12-31' })).status).toBe(403);
  });
});
