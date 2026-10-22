import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let X: Tenant; let Y: Tenant; let emp: string; let emp2: string; let gone: string;
type M = 'get' | 'put';
const call = async (m: M, sub: string, t: Tenant, path: string, body?: object, mfa = true) => w.h.http()[m](path).set(await w.as(sub, t, { mfa })).send(body);
const userId = async (sub: string) => (await w.admin.query<{ id: string }>('SELECT id FROM users WHERE identity_subject=$1', [sub])).rows[0]!.id;

beforeAll(async () => {
  w = await createWorld();
  X = await w.tenant('ll-a', 'lla-root'); Y = await w.tenant('ll-b', 'llb-root');
  await w.member(X, 'lla-root-boot', 'll-hr', ['hr_admin']);
  await w.member(X, 'lla-root-boot', 'll-newbie', ['employee'], [X.branch]);
  await w.member(X, 'lla-root-boot', 'll-newbie2', ['employee'], [X.branch]);
  await w.member(Y, 'llb-root-boot', 'll-outsider', ['employee']);
  emp = await w.employee(X, 'lla-root-boot', null, { joined: '2024-01-01', name: 'Uma' });
  emp2 = await w.employee(X, 'lla-root-boot', null, { joined: '2024-01-01', name: 'Vik' });
  gone = await w.employee(X, 'lla-root-boot', null, { joined: '2024-01-01', name: 'Gita', status: 'archived' });
});
afterAll(() => w.close());

describe('giving an employee a login', () => {
  it('only a company administrator can; HR cannot, and MFA is required', async () => {
    const u = await userId('ll-newbie');
    expect((await call('put', 'll-hr', X, `/employees/${emp}/login`, { userId: u })).status).toBe(403);
    expect((await call('put', 'lla-root-boot', X, `/employees/${emp}/login`, { userId: u }, false)).status).toBe(403);
  });
  it('links, makes self-service work at once, and audits', async () => {
    const u = await userId('ll-newbie');
    const r = await call('put', 'lla-root-boot', X, `/employees/${emp}/login`, { userId: u });
    expect(r.status).toBe(200); expect(r.body.data).toEqual({ employeeId: emp, userId: u });
    const mine = await call('get', 'll-newbie', X, `/employees/${emp}`);
    expect(mine.status).toBe(200);
    expect((await call('get', 'll-newbie', X, `/employees/${emp2}`)).status).toBe(403);
    const users = await call('get', 'lla-root-boot', X, '/access/users');
    expect(users.body.data.find((x: { userId: string }) => x.userId === u).employeeId).toBe(emp);
    const a = await w.admin.query(`SELECT action FROM audit_logs WHERE tenant_id=$1 AND entity_id=$2 AND action='employee.link_login'`, [X.id, emp]);
    expect(a.rowCount).toBe(1);
  });
  it('is idempotent for the same person and refuses a second login or a login already in use', async () => {
    const u = await userId('ll-newbie'); const u2 = await userId('ll-newbie2');
    expect((await call('put', 'lla-root-boot', X, `/employees/${emp}/login`, { userId: u })).status).toBe(200);
    expect((await call('put', 'lla-root-boot', X, `/employees/${emp}/login`, { userId: u2 })).status).toBe(409);
    expect((await call('put', 'lla-root-boot', X, `/employees/${emp2}/login`, { userId: u })).status).toBe(409);
  });
  it('refuses people outside the company, unknown employees and exited employees', async () => {
    const outsider = await userId('ll-outsider'); const u2 = await userId('ll-newbie2');
    expect((await call('put', 'lla-root-boot', X, `/employees/${emp2}/login`, { userId: outsider })).status).toBe(422);
    expect((await call('put', 'lla-root-boot', X, `/employees/${gone}/login`, { userId: u2 })).status).toBe(409);
    expect((await call('put', 'lla-root-boot', X, `/employees/00000000-0000-4000-8000-000000000000/login`, { userId: u2 })).status).toBe(404);
    expect((await call('put', 'lla-root-boot', X, `/employees/${emp2}/login`, { userId: 'nope' })).status).toBe(422);
  });
  it('can be removed again, after which self-service stops', async () => {
    expect((await call('put', 'lla-root-boot', X, `/employees/${emp}/login`, { userId: null })).status).toBe(200);
    expect((await call('get', 'll-newbie', X, `/employees/${emp}`)).status).toBe(403);
    expect((await call('put', 'lla-root-boot', X, `/employees/${emp}/login`, { userId: null })).status).toBe(200);
  });
  it('another company cannot touch this employee', async () => {
    const outsider = await userId('ll-outsider');
    expect((await call('put', 'llb-root-boot', Y, `/employees/${emp2}/login`, { userId: outsider })).status).toBe(404);
  });
});
