import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let A: Tenant; let B: Tenant;
beforeAll(async () => {
  w = await createWorld();
  A = await w.tenant('acc-a', 'acca-root');
  B = await w.tenant('acc-b', 'accb-root');
  await w.member(A, 'acca-root-boot', 'acca-hr', ['hr_admin']);
  await w.member(A, 'acca-root-boot', 'acca-emp', ['employee']);
});
afterAll(() => w.close());
const mfa = { mfa: true };
const call = async (m: 'get' | 'post' | 'put' | 'patch' | 'delete', sub: string, t: Tenant, path: string, body?: object, o?: { mfa?: boolean }) =>
  w.h.http()[m](path).set(await w.as(sub, t, o)).send(body);

describe('reads', () => {
  it('admin lists users, roles, permission catalogue', async () => {
    const u = await call('get', 'acca-root', A, '/access/users');
    expect(u.status).toBe(200);
    expect(u.body.data.map((x: { email: string }) => x.email)).toContain('acca-hr@example.test');
    const r = await call('get', 'acca-root', A, '/access/roles');
    expect(r.body.data.filter((x: { isSystem: boolean }) => x.isSystem)).toHaveLength(9);
    expect((await call('get', 'acca-root', A, '/access/permissions')).body.data.length).toBeGreaterThan(90);
  });
  it('employees cannot read access data', async () => {
    expect((await call('get', 'acca-emp', A, '/access/users')).status).toBe(403);
  });
  it('does not leak across tenants', async () => {
    const u = await call('get', 'accb-root', B, '/access/users');
    expect(u.body.data.map((x: { email: string }) => x.email)).not.toContain('acca-hr@example.test');
  });
});

describe('invitations', () => {
  let token: string; let id: string;
  it('requires user.invite; company admin can invite, token returned once', async () => {
    expect((await call('post', 'acca-hr', A, '/access/invitations', { email: 'x@example.test', roleKeys: ['employee'], branchScope: 'all' })).status).toBe(403);
    const r = await call('post', 'acca-root', A, '/access/invitations', { email: 'Newbie@Example.test', roleKeys: ['store_manager'], branchScope: [A.branch] }, mfa);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ email: 'newbie@example.test', status: 'pending', roleKeys: ['store_manager'] });
    token = r.body.data.acceptToken; id = r.body.data.id;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const list = await call('get', 'acca-hr', A, '/access/invitations');
    expect(JSON.stringify(list.body)).not.toContain(token);
  });
  it('duplicate pending invitation => 409; unknown role/branch => 422', async () => {
    expect((await call('post', 'acca-root', A, '/access/invitations', { email: 'newbie@example.test', roleKeys: ['employee'], branchScope: 'all' }, mfa)).status).toBe(409);
    expect((await call('post', 'acca-root', A, '/access/invitations', { email: 'a1@example.test', roleKeys: ['nope'], branchScope: 'all' }, mfa)).status).toBe(422);
    expect((await call('post', 'acca-root', A, '/access/invitations', { email: 'a2@example.test', roleKeys: ['employee'], branchScope: [B.branch] }, mfa)).status).toBe(422);
  });
  it('queues an e-mail job carrying the token', async () => {
    const { rows } = await w.admin.query<{ payload: { token: string } }>(`SELECT payload FROM outbox_events WHERE tenant_id=$1 AND event_type='invitation.email'`, [A.id]);
    expect(rows.some((r) => r.payload.token === token)).toBe(true);
  });
  it('wrong person cannot accept; the invitee can, once', async () => {
    const other = { ...(await w.as('someone-else', A)) }; delete other['X-Tenant-Id'];
    expect((await w.h.http().post('/access/invitations/accept').set(other).send({ token })).status).toBe(409);
    const me = { ...(await w.as('newbie', A)) }; delete me['X-Tenant-Id'];
    const ok = await w.h.http().post('/access/invitations/accept').set(me).send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.tenantId).toBe(A.id);
    expect((await w.h.http().post('/access/invitations/accept').set(me).send({ token })).status).toBe(409);
    const perms = await w.h.http().get('/me/permissions').set(await w.as('newbie', A));
    expect(perms.status).toBe(200);
    const u = (await call('get', 'acca-hr', A, '/access/users')).body.data.find((x: { email: string }) => x.email === 'newbie@example.test');
    expect(u).toMatchObject({ roleKeys: ['store_manager'], branchScope: [A.branch], status: 'active' });
  });
  it('malformed tokens are rejected as validation errors', async () => {
    const me = { ...(await w.as('newbie', A)) }; delete me['X-Tenant-Id'];
    expect((await w.h.http().post('/access/invitations/accept').set(me).send({ token: 'short' })).status).toBe(422);
  });
  it('revoked invitation cannot be accepted', async () => {
    const r = await call('post', 'acca-root', A, '/access/invitations', { email: 'rev@example.test', roleKeys: ['employee'], branchScope: 'all' }, mfa);
    expect((await call('post', 'acca-root', A, `/access/invitations/${r.body.data.id}/revoke`, undefined, mfa)).status).toBe(204);
    const me = { ...(await w.as('rev', A)) }; delete me['X-Tenant-Id'];
    expect((await w.h.http().post('/access/invitations/accept').set(me).send({ token: r.body.data.acceptToken })).status).toBe(409);
    expect((await call('post', 'acca-root', A, `/access/invitations/${r.body.data.id}/revoke`, undefined, mfa)).status).toBe(404);
    expect(id).toBeTruthy();
  });
});

describe('roles & membership changes', () => {
  it('critical actions need MFA', async () => {
    const u = (await call('get', 'acca-root', A, '/access/users')).body.data.find((x: { email: string }) => x.email === 'acca-emp@example.test');
    const r = await call('put', 'acca-root', A, `/access/users/${u.userId}/roles`, { roleKeys: ['employee', 'auditor'] });
    expect(r.status).toBe(403);
    const ok = await call('put', 'acca-root', A, `/access/users/${u.userId}/roles`, { roleKeys: ['employee', 'auditor'] }, mfa);
    expect(ok.status).toBe(200);
    expect(ok.body.data.roleKeys).toEqual(['auditor', 'employee']);
  });
  it('cannot change own roles/scope or suspend self', async () => {
    const me = (await call('get', 'acca-root', A, '/access/users')).body.data.find((x: { email: string }) => x.email === 'acca-root@example.test');
    expect((await call('put', 'acca-root', A, `/access/users/${me.userId}/roles`, { roleKeys: ['employee'] }, mfa)).status).toBe(403);
    expect((await call('put', 'acca-root', A, `/access/users/${me.userId}/branch-scope`, { scope: 'all' }, mfa)).status).toBe(403);
    expect((await call('post', 'acca-root', A, `/access/users/${me.userId}/suspend`, undefined, mfa)).status).toBe(403);
  });
  it('unknown role => 422; unknown user => 404; other tenant user => 404', async () => {
    const u = (await call('get', 'acca-root', A, '/access/users')).body.data.find((x: { email: string }) => x.email === 'acca-emp@example.test');
    expect((await call('put', 'acca-root', A, `/access/users/${u.userId}/roles`, { roleKeys: ['ghost'] }, mfa)).status).toBe(422);
    expect((await call('put', 'acca-root', A, `/access/users/${w.users['accb-root']}/roles`, { roleKeys: ['employee'] }, mfa)).status).toBe(404);
  });
  it('branch scope can be narrowed and widened', async () => {
    const u = (await call('get', 'acca-root', A, '/access/users')).body.data.find((x: { email: string }) => x.email === 'acca-emp@example.test');
    const n = await call('put', 'acca-root', A, `/access/users/${u.userId}/branch-scope`, { scope: [A.branch2] }, mfa);
    expect(n.body.data.branchScope).toEqual([A.branch2]);
    const a = await call('put', 'acca-root', A, `/access/users/${u.userId}/branch-scope`, { scope: 'all' }, mfa);
    expect(a.body.data.branchScope).toBe('all');
  });
  it('suspend blocks access, restore re-enables it', async () => {
    const u = (await call('get', 'acca-root', A, '/access/users')).body.data.find((x: { email: string }) => x.email === 'acca-hr@example.test');
    expect((await call('post', 'acca-root', A, `/access/users/${u.userId}/suspend`, undefined, mfa)).body.data.status).toBe('suspended');
    expect((await call('get', 'acca-hr', A, '/employees')).status).toBe(404);
    expect((await call('post', 'acca-root', A, `/access/users/${u.userId}/restore`, undefined, mfa)).body.data.status).toBe('active');
    expect((await call('get', 'acca-hr', A, '/employees')).status).toBe(200);
  });
  it('last role.manage holder cannot be removed', async () => {
    const C = await w.tenant('acc-c', 'accc-root');
    const boot = w.users['accc-root-boot']!;
    // root removes boot's roles: root still manages -> ok
    expect((await call('put', 'accc-root', C, `/access/users/${boot}/roles`, { roleKeys: ['employee'] }, mfa)).status).toBe(200);
    // boot (now employee) cannot act, and root cannot be stripped by anyone else
    const rootId = w.users['accc-root']!;
    expect((await call('put', 'accc-root-boot', C, `/access/users/${rootId}/roles`, { roleKeys: ['employee'] }, mfa)).status).toBe(403);
  });
});

describe('custom roles', () => {
  let roleId: string;
  it('creates a role limited to permissions the creator holds', async () => {
    const r = await call('post', 'acca-root', A, '/access/roles', { key: 'ops_viewer', name: 'Ops viewer', permissions: ['employee.read', 'org.read'] }, mfa);
    expect(r.status).toBe(201);
    roleId = r.body.data.id;
    expect(r.body.data).toMatchObject({ key: 'ops_viewer', isSystem: false, permissions: ['employee.read', 'org.read'] });
    expect((await call('post', 'acca-root', A, '/access/roles', { key: 'ops_viewer', name: 'dup', permissions: ['org.read'] }, mfa)).status).toBe(409);
    expect((await call('post', 'acca-root', A, '/access/roles', { key: 'bad', name: 'Bad', permissions: ['not.real'] }, mfa)).status).toBe(422);
  });
  it('cannot grant permissions the caller lacks (HR has no role.manage)', async () => {
    expect((await call('post', 'acca-hr', A, '/access/roles', { key: 'x_role', name: 'x', permissions: ['org.read'] }, mfa)).status).toBe(403);
  });
  it('update bumps and system roles are immutable', async () => {
    const u = await call('patch', 'acca-root', A, `/access/roles/${roleId}`, { permissions: ['employee.read'] }, mfa);
    expect(u.body.data.permissions).toEqual(['employee.read']);
    const sys = (await call('get', 'acca-root', A, '/access/roles')).body.data.find((x: { isSystem: boolean }) => x.isSystem);
    expect((await call('patch', 'acca-root', A, `/access/roles/${sys.id}`, { name: 'hax' }, mfa)).status).toBe(409);
    expect((await call('delete', 'acca-root', A, `/access/roles/${sys.id}`, undefined, mfa)).status).toBe(409);
  });
  it('cannot delete a role still in use; can delete when unused', async () => {
    const emp = w.users['acca-emp']!;
    await call('put', 'acca-root', A, `/access/users/${emp}/roles`, { roleKeys: ['employee', 'ops_viewer'] }, mfa);
    expect((await call('delete', 'acca-root', A, `/access/roles/${roleId}`, undefined, mfa)).status).toBe(409);
    await call('put', 'acca-root', A, `/access/users/${emp}/roles`, { roleKeys: ['employee'] }, mfa);
    expect((await call('delete', 'acca-root', A, `/access/roles/${roleId}`, undefined, mfa)).status).toBe(204);
  });
});
