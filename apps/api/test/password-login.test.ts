import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let X: Tenant; let Y: Tenant;
let e1: string; let e2: string; let e3: string; let eHr: string; let gone: string; let other: string;
const post = async (sub: string, t: Tenant, path: string, body?: object, mfa = true) => w.h.http().post(path).set(await w.as(sub, t, { mfa })).send(body);
const anon = (path: string, body: object) => w.h.http().post(path).send(body);
const bearer = (token: string, t?: Tenant) => ({ Authorization: `Bearer ${token}`, ...(t ? { 'X-Tenant-Id': t.id } : {}) });
const PW = 'Sunrise-2468';

beforeAll(async () => {
  w = await createWorld();
  X = await w.tenant('pw-a', 'pwa-root'); Y = await w.tenant('pw-b', 'pwb-root');
  await w.member(X, 'pwa-root-boot', 'pw-hr', ['hr_admin']);
  await w.member(X, 'pwa-root-boot', 'pw-mgr', ['manager']);
  e1 = await w.employee(X, 'pwa-root-boot', null, { name: 'Asha' });
  e2 = await w.employee(X, 'pwa-root-boot', null, { name: 'Bala' });
  e3 = await w.employee(X, 'pwa-root-boot', null, { name: 'Chitra' });
  eHr = await w.employee(X, 'pwa-root-boot', null, { name: 'Deepa' });
  gone = await w.employee(X, 'pwa-root-boot', null, { name: 'Gita', status: 'archived' });
  other = await w.employee(Y, 'pwb-root-boot', null, { name: 'Omar' });
});
afterAll(() => w.close());

describe('login codes and passwords', () => {
  let code1: string; let token1: string;

  it('HR can create a login code for an employee; a manager cannot; it is never created for another company or an archived employee', async () => {
    expect((await post('pw-mgr', X, '/access/login-codes', { employeeId: e1, email: 'asha@corp.test' })).status).toBe(403);
    expect((await post('pw-hr', X, '/access/login-codes', { employeeId: other, email: 'omar@corp.test' })).status).toBe(404);
    expect((await post('pw-hr', X, '/access/login-codes', { employeeId: gone, email: 'gita@corp.test' })).status).toBe(409);
    const r = await post('pw-hr', X, '/access/login-codes', { employeeId: e1, email: 'Asha@Corp.test' }, false);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ employeeId: e1, email: 'asha@corp.test', roleKeys: ['employee'] });
    expect(r.body.data.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    code1 = r.body.data.code;
    const stored = await w.admin.query(`SELECT encode(token_hash,'hex') h, kind FROM invitations WHERE id=$1`, [r.body.data.invitationId]);
    expect(stored.rows[0].kind).toBe('code'); expect(stored.rows[0].h).not.toContain(code1.toLowerCase());
  });

  it('HR cannot hand out a role other than Employee; an administrator can, but only with a second factor', async () => {
    expect((await post('pw-hr', X, '/access/login-codes', { employeeId: eHr, email: 'deepa@corp.test', roleKeys: ['hr_admin'] })).status).toBe(403);
    const noMfa = await post('pwa-root', X, '/access/login-codes', { employeeId: eHr, email: 'deepa@corp.test', roleKeys: ['hr_admin'] }, false);
    expect(noMfa.status).toBe(403); expect(noMfa.body.error.code).toBe('mfa_required');
    const ok = await post('pwa-root', X, '/access/login-codes', { employeeId: eHr, email: 'deepa@corp.test', roleKeys: ['employee', 'hr_admin'] });
    expect(ok.status).toBe(201);
    const act = await anon('/auth/password/activate', { email: 'deepa@corp.test', code: ok.body.data.code, password: PW });
    expect(act.status).toBe(200);
    const perms = await w.h.http().get('/me/permissions').set(bearer(act.body.data.token, X));
    expect(perms.body.data.permissions).toContain('employee.create');
    expect(perms.body.data.mfaVerified).toBe(false);
  });

  it('a wrong code is refused and a weak password is refused', async () => {
    expect((await anon('/auth/password/activate', { email: 'asha@corp.test', code: 'AAAAABBBBB', password: PW })).status).toBe(409);
    expect((await anon('/auth/password/activate', { email: 'asha@corp.test', code: code1, password: 'short1' })).status).toBe(422);
    expect((await anon('/auth/password/activate', { email: 'asha@corp.test', code: code1, password: 'onlyletters' })).status).toBe(422);
    expect((await anon('/auth/password/activate', { email: 'someoneelse@corp.test', code: code1, password: PW })).status).toBe(409);
  });

  it('e-mail + code + a new password creates the login, links the employee and signs in; the code is then spent', async () => {
    const r = await anon('/auth/password/activate', { email: ' ASHA@corp.test ', code: `${code1.slice(0, 5).toLowerCase()}-${code1.slice(5)}`, password: PW });
    expect(r.status).toBe(200); expect(r.body.data.tenantId).toBe(X.id);
    token1 = r.body.data.token;
    const me = await w.h.http().get('/me').set(bearer(token1));
    expect(me.status).toBe(200); expect(me.body.data.email).toBe('asha@corp.test'); expect(me.body.data.companies.map((c: { id: string }) => c.id)).toEqual([X.id]);
    const perms = await w.h.http().get('/me/permissions').set(bearer(token1, X));
    expect(perms.body.data.employeeId).toBe(e1);
    expect(perms.body.data.permissions).toContain('leave.request'); expect(perms.body.data.permissions).not.toContain('employee.create');
    expect((await w.h.http().get(`/employees/${e1}`).set(bearer(token1, X))).status).toBe(200);
    expect((await w.h.http().get(`/employees/${e2}`).set(bearer(token1, X))).status).toBe(403);
    expect((await w.h.http().get('/me/permissions').set(bearer(token1, Y))).status).toBe(404);
    expect((await anon('/auth/password/activate', { email: 'asha@corp.test', code: code1, password: 'Another-9876' })).status).toBe(409);
    const hash = await w.admin.query(`SELECT c.password_hash FROM user_credentials c JOIN users u ON u.id=c.user_id WHERE u.email_normalized='asha@corp.test'`);
    expect(hash.rows[0].password_hash).toMatch(/^scrypt\$/); expect(hash.rows[0].password_hash).not.toContain(PW);
    const audit = await w.admin.query(`SELECT action FROM audit_logs WHERE tenant_id=$1 AND action IN ('login_code.issue','invitation.accept','employee.link_login') AND (entity_id=$2 OR entity_type='invitations')`, [X.id, e1]);
    expect(new Set(audit.rows.map((x) => x.action))).toEqual(new Set(['login_code.issue', 'invitation.accept', 'employee.link_login']));
  });

  it('afterwards the person signs in with e-mail + password; a wrong password or unknown e-mail gets the same answer', async () => {
    const ok = await anon('/auth/password/login', { email: 'asha@corp.test', password: PW });
    expect(ok.status).toBe(200);
    expect((await w.h.http().get('/me').set(bearer(ok.body.data.token))).status).toBe(200);
    const bad = await anon('/auth/password/login', { email: 'asha@corp.test', password: 'Wrong-0000' });
    const unknown = await anon('/auth/password/login', { email: 'nobody@corp.test', password: 'Wrong-0000' });
    expect(bad.status).toBe(401); expect(unknown.status).toBe(401); expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  it('the application database role cannot read password hashes', async () => {
    await expect(w.app.query('SELECT 1 FROM user_credentials')).rejects.toThrow(/permission denied/);
  });

  it('an employee who already has a login cannot be given a second one, and their e-mail cannot be reused', async () => {
    expect((await post('pw-hr', X, '/access/login-codes', { employeeId: e1, email: 'asha2@corp.test' })).status).toBe(409);
    expect((await post('pw-hr', X, '/access/login-codes', { employeeId: e2, email: 'asha@corp.test' })).status).toBe(409);
  });

  it('a new code replaces the old one, and five wrong guesses cancel a code', async () => {
    const a = await post('pw-hr', X, '/access/login-codes', { employeeId: e2, email: 'bala@corp.test' });
    const b = await post('pw-hr', X, '/access/login-codes', { employeeId: e2, email: 'bala@corp.test' });
    expect(b.status).toBe(201);
    expect((await anon('/auth/password/activate', { email: 'bala@corp.test', code: a.body.data.code, password: PW })).status).toBe(409);
    for (let i = 0; i < 5; i++) expect((await anon('/auth/password/activate', { email: 'bala@corp.test', code: 'ZZZZZ22222', password: PW })).status).toBe(409);
    expect((await anon('/auth/password/activate', { email: 'bala@corp.test', code: b.body.data.code, password: PW })).status).toBe(409);
    const st = await w.admin.query(`SELECT status FROM invitations WHERE id=$1`, [b.body.data.invitationId]);
    expect(st.rows[0].status).toBe('revoked');
  });

  it('a code can be cancelled before it is used', async () => {
    const a = await post('pw-hr', X, '/access/login-codes', { employeeId: e3, email: 'chitra@corp.test' });
    expect((await post('pw-mgr', X, `/access/login-codes/${a.body.data.invitationId}/revoke`)).status).toBe(403);
    expect((await post('pw-hr', X, `/access/login-codes/${a.body.data.invitationId}/revoke`)).status).toBe(204);
    expect((await anon('/auth/password/activate', { email: 'chitra@corp.test', code: a.body.data.code, password: PW })).status).toBe(409);
  });

  it('forgotten password: HR issues a reset code for an employee, which replaces the password and nothing else', async () => {
    expect((await post('pw-hr', X, '/access/password-resets', { employeeId: e3 })).status).toBe(409);       // no login yet
    const r = await post('pw-hr', X, '/access/password-resets', { employeeId: e1 });
    expect(r.status).toBe(201); expect(r.body.data.email).toBe('asha@corp.test');
    expect((await anon('/auth/password/login', { email: 'asha@corp.test', password: PW })).status).toBe(200);   // old one works until used
    const act = await anon('/auth/password/activate', { email: 'asha@corp.test', code: r.body.data.code, password: 'Moonlight-1357' });
    expect(act.status).toBe(200);
    expect((await anon('/auth/password/login', { email: 'asha@corp.test', password: PW })).status).toBe(401);
    expect((await anon('/auth/password/login', { email: 'asha@corp.test', password: 'Moonlight-1357' })).status).toBe(200);
    const perms = await w.h.http().get('/me/permissions').set(bearer(act.body.data.token, X));
    expect(perms.body.data.permissions).not.toContain('employee.create');
    expect((await anon('/auth/password/activate', { email: 'asha@corp.test', code: r.body.data.code, password: 'Again-24680' })).status).toBe(409);
  });

  it('HR cannot reset the password of someone with more than the Employee role', async () => {
    expect((await post('pw-hr', X, '/access/password-resets', { employeeId: eHr })).status).toBe(403);
    expect((await post('pwa-root', X, '/access/password-resets', { employeeId: eHr }, false)).status).toBe(403);
    expect((await post('pwa-root', X, '/access/password-resets', { employeeId: eHr })).status).toBe(201);
  });

  it('five wrong passwords lock the account for a while, even for the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await anon('/auth/password/login', { email: 'deepa@corp.test', password: 'Wrong-0000' })).status).toBe(401);
    expect((await anon('/auth/password/login', { email: 'deepa@corp.test', password: PW })).status).toBe(429);
  });

  it('a password session token cannot be forged with another key or issuer', async () => {
    const forged = await w.h.token('local:00000000-0000-4000-8000-000000000000', { iss: 'humantech-password', email: 'asha@corp.test' });
    expect((await w.h.http().get('/me').set(bearer(forged))).status).toBe(401);
  });
});
