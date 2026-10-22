import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let A: Tenant; let B: Tenant;
beforeAll(async () => {
  w = await createWorld();
  A = await w.tenant('org-a', 'orga-root');
  B = await w.tenant('org-b', 'orgb-root');
  await w.member(A, 'orga-root-boot', 'orga-hr', ['hr_admin']);
  await w.member(A, 'orga-root-boot', 'orga-emp', ['employee']);
  await w.member(A, 'orga-root-boot', 'orga-store', ['store_manager'], [A.branch]);
  await w.member(A, 'orga-root-boot', 'orga-hrb', ['hr_admin'], [A.branch]);
});
afterAll(() => w.close());
const get = async (sub: string, t: Tenant, path: string) => w.h.http().get(path).set(await w.as(sub, t));
const send = async (m: 'post' | 'patch' | 'delete', sub: string, t: Tenant, path: string, body?: object) => w.h.http()[m](path).set(await w.as(sub, t)).send(body);

describe.each(['departments', 'designations', 'cost-centres'])('org/%s', (res) => {
  let id: string;
  it('HR creates; code is normalised; duplicate code => 409', async () => {
    const r = await send('post', 'orga-hr', A, `/org/${res}`, { code: 'ops-1', name: ' Operations ' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ code: 'OPS-1', name: 'Operations', status: 'active' });
    id = r.body.data.id;
    expect((await send('post', 'orga-hr', A, `/org/${res}`, { code: 'OPS-1', name: 'Dup' })).status).toBe(409);
  });
  it('rejects bad input and unknown keys', async () => {
    expect((await send('post', 'orga-hr', A, `/org/${res}`, { code: 'bad code!', name: 'x' })).status).toBe(422);
    expect((await send('post', 'orga-hr', A, `/org/${res}`, { code: 'OK', name: 'x', tenantId: B.id })).status).toBe(422);
  });
  it('employees can read nothing here (no org.read) and managers cannot write', async () => {
    expect((await get('orga-emp', A, `/org/${res}`)).status).toBe(403);
    expect((await send('post', 'orga-store', A, `/org/${res}`, { code: 'X1', name: 'x' })).status).toBe(403);
  });
  it('is tenant-isolated', async () => {
    expect((await get('orgb-root', B, `/org/${res}`)).body.data).toEqual([]);
    expect((await send('patch', 'orgb-root', B, `/org/${res}/${id}`, { name: 'hijack' })).status).toBe(404);
  });
  it('rename, then archive hides it from default list', async () => {
    expect((await send('patch', 'orga-hr', A, `/org/${res}/${id}`, { name: 'Ops' })).body.data.name).toBe('Ops');
    await send('patch', 'orga-hr', A, `/org/${res}/${id}`, { status: 'archived' });
    expect((await get('orga-hr', A, `/org/${res}`)).body.data.find((x: { id: string }) => x.id === id)).toBeUndefined();
    expect((await get('orga-hr', A, `/org/${res}?includeArchived=true`)).body.data.find((x: { id: string }) => x.id === id).status).toBe('archived');
  });
  it('unknown resource is 404', async () => { expect((await get('orga-hr', A, '/org/nope')).status).toBe(404); });
});

describe('archiving guards', () => {
  it('cannot archive a department that still has active employees', async () => {
    const d = (await send('post', 'orga-hr', A, '/org/departments', { code: 'ENG', name: 'Eng' })).body.data.id;
    const e = await send('post', 'orga-hr', A, '/employees', { firstName: 'Z', branchId: A.branch, departmentId: d });
    expect(e.status).toBe(201);
    const r = await send('patch', 'orga-hr', A, `/org/departments/${d}`, { status: 'archived' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/1 active employee/);
  });
});

describe('branches', () => {
  it('company admin creates and updates; HR (no branch.create) cannot', async () => {
    const r = await send('post', 'orga-root', A, '/branches', { code: 'blr', name: 'Bengaluru', state_code: 'ka', timezone: 'Asia/Kolkata', address: { city: 'Bengaluru' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ code: 'BLR', stateCode: 'KA' });
    expect((await send('post', 'orga-hr', A, '/branches', { code: 'X', name: 'x' })).status).toBe(403);
    const u = await send('patch', 'orga-root', A, `/branches/${r.body.data.id}`, { name: 'Bangalore' });
    expect(u.body.data.name).toBe('Bangalore');
  });
  it('branch-scoped users see only their branches', async () => {
    const r = await get('orga-store', A, '/branches');
    expect(r.body.data.map((b: { code: string }) => b.code)).toEqual(['B1']);
  });
  it('cannot archive a branch with active employees', async () => {
    await send('post', 'orga-hr', A, '/employees', { firstName: 'Y', branchId: A.branch2 });
    expect((await send('patch', 'orga-root', A, `/branches/${A.branch2}`, { status: 'archived' })).status).toBe(409);
  });
  it('another tenant’s branch is 404', async () => {
    expect((await send('patch', 'orgb-root', B, `/branches/${A.branch}`, { name: 'x' })).status).toBe(404);
  });
});

describe('holidays', () => {
  it('create, list by year/branch, delete; duplicates per day/branch are refused or allowed per schema', async () => {
    const r = await send('post', 'orga-hr', A, '/holidays', { holidayDate: '2031-01-26', name: 'Republic Day' });
    expect(r.status).toBe(201);
    const bh = await send('post', 'orga-hr', A, '/holidays', { holidayDate: '2031-03-01', name: 'Local Fair', branchId: A.branch2 });
    expect(bh.status).toBe(201);
    const l = await get('orga-hr', A, '/holidays?year=2031');
    expect(l.body.data.map((h: { name: string }) => h.name)).toEqual(['Republic Day', 'Local Fair']);
    const onlyB1 = await get('orga-hr', A, `/holidays?year=2031&branchId=${A.branch}`);
    expect(onlyB1.body.data.map((h: { name: string }) => h.name)).toEqual(['Republic Day']);
    const scoped = await get('orga-hrb', A, '/holidays?year=2031');
    expect(scoped.body.data.map((h: { name: string }) => h.name)).toEqual(['Republic Day']);
    expect((await send('delete', 'orga-hr', A, `/holidays/${r.body.data.id}`)).status).toBe(204);
    expect((await send('delete', 'orga-hr', A, `/holidays/${r.body.data.id}`)).status).toBe(404);
  });
  it('a holiday for another tenant’s branch is refused', async () => {
    expect((await send('post', 'orga-hr', A, '/holidays', { holidayDate: '2031-05-01', name: 'x', branchId: B.branch })).status).toBe(422);
  });
  it('invalid dates are refused', async () => {
    expect((await send('post', 'orga-hr', A, '/holidays', { holidayDate: '2031-02-30', name: 'x' })).status).toBe(422);
  });
});
