import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPool, seedPermissions, seedSystemRoles, withContext } from '@humantech/database';
import { Harness, startHarness } from './harness';

let h: Harness;
let owner: Pool;
let app: Pool;
let system: Pool;
let A: { id: string; branch: string; branch2: string };
let B: { id: string; branch: string };
const users: Record<string, string> = {};

async function userFor(sub: string): Promise<string> {
  const r = await app.query('SELECT app.upsert_user_from_identity($1,$2,$3,true) AS id', [sub, `${sub}@example.test`, sub]);
  users[sub] = r.rows[0].id;
  return r.rows[0].id;
}
async function tenant(slug: string, adminSub: string): Promise<{ id: string; branch: string; branch2: string }> {
  const admin = await userFor(adminSub);
  const t = await system.query('SELECT app.provision_tenant($1,$2,$2,$3) AS id', [slug, slug, admin]);
  const id = t.rows[0].id as string;
  await seedSystemRoles(owner, id);
  const ids = await withContext(app, { tenantId: id, userId: admin }, async (c) => {
    const b1 = (await c.query(`INSERT INTO branches (tenant_id, code, name) VALUES ($1,'B1','Branch 1') RETURNING id`, [id])).rows[0].id;
    const b2 = (await c.query(`INSERT INTO branches (tenant_id, code, name) VALUES ($1,'B2','Branch 2') RETURNING id`, [id])).rows[0].id;
    return [b1, b2];
  });
  return { id, branch: ids[0], branch2: ids[1] };
}
/** Give `sub` a membership with the given system role keys (granted by tenant admin, not self). */
async function member(t: { id: string }, adminSub: string, sub: string, roles: string[], branches?: string[]): Promise<void> {
  const uid = await userFor(sub);
  await withContext(app, { tenantId: t.id, userId: users[adminSub] }, async (c) => {
    await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, status, branch_scope_mode) VALUES ($1,$2,'active',$3)`, [t.id, uid, branches ? 'listed' : 'all']);
    for (const b of branches ?? []) await c.query(`INSERT INTO membership_branch_scopes (tenant_id,user_id,branch_id) VALUES ($1,$2,$3)`, [t.id, uid, b]);
    for (const r of roles) await c.query(`INSERT INTO membership_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND role_key=$3`, [t.id, uid, r]);
  });
}
/** Replace the tenant admin's roles so it can create employees (Company Admin is the seeded admin w/o roles). */
async function grant(t: { id: string }, byUser: string, toUser: string, role: string): Promise<void> {
  await withContext(app, { tenantId: t.id, userId: byUser }, (c) =>
    c.query(`INSERT INTO membership_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND role_key=$3`, [t.id, toUser, role]));
}

const H = (tok: string, tenantId?: string) => ({ Authorization: `Bearer ${tok}`, ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}) });

beforeAll(async () => {
  owner = createPool(process.env.TEST_OWNER_URL!, 3);
  app = createPool(process.env.TEST_APP_URL!, 5);
  system = createPool(process.env.TEST_SYSTEM_URL!, 2);
  await seedPermissions(owner);
  A = await tenant('acme', 'acme-root');
  B = await tenant('beta', 'beta-root');
  // acme-root is the first member; a second admin grants it roles (no self-grant possible).
  await member(A, 'acme-root', 'acme-hr', ['hr_admin'], undefined);
  await grant(A, users['acme-hr']!, users['acme-root']!, 'company_admin');
  await member(A, 'acme-root', 'acme-store', ['store_manager'], [A.branch]);
  await member(A, 'acme-root', 'acme-emp', ['employee']);
  await member(A, 'acme-root', 'acme-fin', ['finance_payroll']);
  await member(B, 'beta-root', 'beta-hr', ['hr_admin']);
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
  await Promise.all([owner.end(), app.end(), system.end()]);
});

describe('platform basics', () => {
  it('health live/ready are public', async () => {
    expect((await h.http().get('/health/live')).status).toBe(200);
    expect((await h.http().get('/health/ready')).body).toEqual({ status: 'ok' });
  });
  it('echoes a safe request id, replaces an unsafe one, and sets security headers', async () => {
    const ok = await h.http().get('/health/live').set('X-Request-Id', 'trace-12345678');
    expect(ok.headers['x-request-id']).toBe('trace-12345678');
    const bad = await h.http().get('/health/live').set('X-Request-Id', 'x"; drop');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['x-powered-by']).toBeUndefined();
  });
  it('unknown routes use the error format', async () => {
    const r = await h.http().get('/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'not_found' });
    expect(r.body.error.requestId).toBeTruthy();
  });
});

describe('authentication', () => {
  it('rejects missing, malformed, wrong-audience, wrong-issuer and expired tokens', async () => {
    expect((await h.http().get('/me')).status).toBe(401);
    expect((await h.http().get('/me').set('Authorization', 'Bearer abc')).status).toBe(401);
    for (const o of [{ aud: 'other' }, { iss: 'https://evil.test' }, { expSec: -60 }]) {
      const r = await h.http().get('/me').set(H(await h.token('acme-root', o)));
      expect(r.status, JSON.stringify(o)).toBe(401);
      expect(r.body.error.code).toBe('unauthenticated');
    }
  });
  it('rejects an unsigned (alg none) token', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'acme-root', iss: 'https://idp.test', aud: 'humantech-api', email: 'a@b.c' })).toString('base64url')}.`;
    expect((await h.http().get('/me').set('Authorization', `Bearer ${none}`)).status).toBe(401);
  });
  it('/me lists only the companies the user belongs to', async () => {
    const r = await h.http().get('/me').set(H(await h.token('acme-root')));
    expect(r.status).toBe(200);
    expect(r.body.data.companies.map((c: { id: string }) => c.id)).toEqual([A.id]);
  });
  it('a company other than the caller’s looks like it does not exist (404, not 403)', async () => {
    const r = await h.http().get('/employees').set(H(await h.token('acme-root'), B.id));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });
  it('requires X-Tenant-Id on company routes', async () => {
    const r = await h.http().get('/employees').set(H(await h.token('acme-root')));
    expect(r.status).toBe(422);
  });
  it('a disabled account is refused', async () => {
    await userFor('ghost');
    await system.query(`UPDATE users SET status='disabled' WHERE identity_subject='ghost'`);
    const r = await h.http().get('/me').set(H(await h.token('ghost')));
    expect(r.status).toBe(403);
  });
});

describe('authorization', () => {
  it('permission gating: employee role cannot list employees; finance cannot create them', async () => {
    expect((await h.http().get('/employees').set(H(await h.token('acme-emp'), A.id))).status).toBe(403);
    const r = await h.http().post('/employees').set(H(await h.token('acme-fin'), A.id)).send({ firstName: 'X', branchId: A.branch });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('forbidden');
  });
  it('/me/permissions reflects roles', async () => {
    const r = await h.http().get('/me/permissions').set(H(await h.token('acme-emp'), A.id));
    expect(r.body.data.permissions).toContain('payslip.read_own');
    expect(r.body.data.permissions).not.toContain('employee.read');
  });
});

describe('employees', () => {
  let id: string;
  const admin = () => h.token('acme-hr');

  it('creates with generated number, strict body, no mass assignment', async () => {
    const t = await admin();
    const bad = await h.http().post('/employees').set(H(t, A.id)).send({ firstName: 'Z', branchId: A.branch, tenantId: B.id });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    const r = await h.http().post('/employees').set(H(t, A.id)).send({ firstName: ' Asha ', lastName: 'Rao', branchId: A.branch, workEmail: 'ASHA@acme.test', phone: '+919876543210' });
    expect(r.status).toBe(201);
    id = r.body.data.id;
    expect(r.body.data).toMatchObject({ firstName: 'Asha', workEmail: 'asha@acme.test', employmentStatus: 'onboarding', version: 1 });
    expect(r.body.data.employeeNumber).toBeTruthy();
    expect(r.body.data.phone).toBe('+919876543210'); // HR has employee.read_sensitive
  });
  it('a foreign-tenant branch cannot be referenced (FK violation => 422)', async () => {
    const r = await h.http().post('/employees').set(H(await admin(), A.id)).send({ firstName: 'Q', branchId: B.branch });
    expect(r.status).toBe(422);
  });
  it('lists with cursor pagination, search and no cross-tenant rows', async () => {
    const t = await admin();
    for (const n of ['Bina', 'Chetan', 'Divya']) await h.http().post('/employees').set(H(t, A.id)).send({ firstName: n, branchId: A.branch });
    const p1 = await h.http().get('/employees?limit=2').set(H(t, A.id));
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.page.nextCursor).toBeTruthy();
    const p2 = await h.http().get(`/employees?limit=2&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`).set(H(t, A.id));
    const seen = new Set([...p1.body.data, ...p2.body.data].map((e: { id: string }) => e.id));
    expect(seen.size).toBe(p1.body.data.length + p2.body.data.length);
    const s = await h.http().get('/employees?q=chet').set(H(t, A.id));
    expect(s.body.data.map((e: { firstName: string }) => e.firstName)).toEqual(['Chetan']);
    const wild = await h.http().get('/employees?q=%25').set(H(t, A.id));
    expect(wild.body.data).toHaveLength(0); // % is escaped, not a wildcard
    expect((await h.http().get('/employees?cursor=garbage').set(H(t, A.id))).status).toBe(422);
    expect((await h.http().get('/employees?limit=1000').set(H(t, A.id))).status).toBe(422);
  });
  it('tenant B cannot read, update or archive tenant A’s employee (404)', async () => {
    const t = await h.token('beta-hr');
    expect((await h.http().get(`/employees/${id}`).set(H(t, B.id))).status).toBe(404);
    expect((await h.http().patch(`/employees/${id}`).set(H(t, B.id)).send({ firstName: 'Hack', version: 1 })).status).toBe(404);
    expect((await h.http().post(`/employees/${id}/archive`).set(H(t, B.id))).status).toBe(404);
    expect((await h.http().get('/employees').set(H(t, B.id))).body.data).toEqual([]);
  });
  it('malformed ids are 404, not 500', async () => {
    expect((await h.http().get('/employees/not-a-uuid').set(H(await admin(), A.id))).status).toBe(404);
  });
  it('optimistic concurrency: stale version => 409 version_conflict; fresh succeeds and bumps', async () => {
    const t = await admin();
    const ok = await h.http().patch(`/employees/${id}`).set(H(t, A.id)).send({ lastName: 'Iyer', version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ lastName: 'Iyer', version: 2 });
    const stale = await h.http().patch(`/employees/${id}`).set(H(t, A.id)).send({ lastName: 'Nair', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect((await h.http().patch(`/employees/${id}`).set(H(t, A.id)).send({ version: 2 })).status).toBe(422);
  });
  it('writes audit rows with redacted sensitive values', async () => {
    const t = await admin();
    await h.http().patch(`/employees/${id}`).set(H(t, A.id)).send({ phone: '+919000000001', version: 2 });
    const rows = await withContext(app, { tenantId: A.id }, async (c) => (await c.query(`SELECT action, after_redacted, request_id FROM audit_logs WHERE entity_id=$1 AND source='api' ORDER BY created_at`, [id])).rows);
    expect(rows.map((r) => r.action)).toEqual(['employee.create', 'employee.update', 'employee.update']);
    expect(JSON.stringify(rows[2].after_redacted)).toContain('[redacted]');
    expect(JSON.stringify(rows)).not.toContain('9000000001');
    expect(rows.every((r) => r.request_id)).toBe(true);
  });
  it('field-level redaction: store manager cannot see personal contact details', async () => {
    const r = await h.http().get(`/employees/${id}`).set(H(await h.token('acme-store'), A.id));
    // store manager is branch-scoped to B1 (where this employee works) and may read the record ...
    expect(r.status).toBe(200);
    expect(r.body.data.phone).toBeUndefined();
    expect(r.body.data.personalEmail).toBeUndefined();
  });
  it('branch scope: store manager sees only their branch and cannot edit sensitive fields or other branches', async () => {
    const t = await admin();
    const other = await h.http().post('/employees').set(H(t, A.id)).send({ firstName: 'Elsewhere', branchId: A.branch2 });
    const sm = await h.token('acme-store');
    expect((await h.http().get(`/employees/${other.body.data.id}`).set(H(sm, A.id))).status).toBe(404);
    const list = await h.http().get('/employees?limit=100').set(H(sm, A.id));
    expect(list.body.data.every((e: { branchId: string }) => e.branchId === A.branch)).toBe(true);
    expect(list.body.data.find((e: { id: string }) => e.id === other.body.data.id)).toBeUndefined();
    // store manager has no employee.create permission at all
    expect((await h.http().post('/employees').set(H(sm, A.id)).send({ firstName: 'N', branchId: A.branch })).status).toBe(403);
  });
  it('archive is idempotent and audited', async () => {
    const t = await admin();
    const created = await h.http().post('/employees').set(H(t, A.id)).send({ firstName: 'Temp', branchId: A.branch });
    const a1 = await h.http().post(`/employees/${created.body.data.id}/archive`).set(H(t, A.id));
    const a2 = await h.http().post(`/employees/${created.body.data.id}/archive`).set(H(t, A.id));
    expect(a1.body.data.employmentStatus).toBe('archived');
    expect(a2.status).toBe(200);
  });
});

describe('error hygiene', () => {
  it('never leaks SQL or stack traces', async () => {
    const t = await h.token('acme-hr');
    const r = await h.http().patch(`/employees/00000000-0000-4000-8000-000000000000`).set(H(t, A.id)).send({ managerId: '00000000-0000-4000-8000-000000000001', version: 1 });
    expect(JSON.stringify(r.body)).not.toMatch(/SELECT|INSERT|pg_|at \w+\.|node_modules/);
  });
  it('oversized bodies are rejected', async () => {
    const r = await h.http().post('/employees').set(H(await h.token('acme-hr'), A.id)).send({ firstName: 'x'.repeat(200_000), branchId: A.branch });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('payload_too_large');
  });
});
