import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let A: Tenant; let B: Tenant; let emp: string; let empB: string;
const call = async (m: 'get' | 'post' | 'patch' | 'delete', sub: string, t: Tenant, path: string, body?: object, o?: { mfa?: boolean }) =>
  w.h.http()[m](path).set(await w.as(sub, t, o)).send(body);
const ids: Record<string, string> = {};

beforeAll(async () => {
  w = await createWorld();
  A = await w.tenant('cp-a', 'cpa-root'); B = await w.tenant('cp-b', 'cpb-root');
  await w.member(A, 'cpa-root-boot', 'cpa-fin', ['finance_payroll']);
  await w.member(A, 'cpa-root-boot', 'cpa-appr', ['payroll_approver']);
  await w.member(A, 'cpa-root-boot', 'cpa-hr', ['hr_admin']);
  await w.member(A, 'cpa-root-boot', 'cpa-emp', ['employee'], [A.branch]);
  await w.member(B, 'cpb-root-boot', 'cpb-fin', ['finance_payroll']);
  emp = await w.employee(A, 'cpa-root-boot', 'cpa-emp');
  empB = await w.employee(B, 'cpb-root-boot', null);
});
afterAll(() => w.close());

const fin = (m: 'get' | 'post' | 'patch' | 'delete', p: string, b?: object) => call(m, 'cpa-fin', A, p, b, { mfa: true });

describe('components & structures', () => {
  it('creates components, versions and activates them', async () => {
    const basic = await fin('post', '/compensation/components', { code: 'basic', label: 'Basic', componentType: 'earning' });
    expect(basic.status).toBe(201);
    const hra = await fin('post', '/compensation/components', { code: 'HRA', label: 'HRA', componentType: 'earning' });
    const spl = await fin('post', '/compensation/components', { code: 'SPECIAL', label: 'Special Allowance', componentType: 'earning' });
    ids.basic = basic.body.data.id; ids.hra = hra.body.data.id; ids.spl = spl.body.data.id;
    expect((await fin('post', '/compensation/components', { code: 'BASIC', label: 'Dup', componentType: 'earning' })).status).toBe(409);

    const vb = await fin('post', `/compensation/components/${ids.basic}/versions`, { calculationMethod: 'fixed', defaultAmount: '20000.00', effectiveFrom: '2030-01-01' });
    expect(vb.status).toBe(201); expect(vb.body.data.version).toBe(1); expect(vb.body.data.status).toBe('draft');
    const vh = await fin('post', `/compensation/components/${ids.hra}/versions`, { calculationMethod: 'percentage_of_component', baseComponentCodes: ['BASIC'], defaultPercentage: '40', effectiveFrom: '2030-01-01' });
    expect(vh.status).toBe(201);
    const vs = await fin('post', `/compensation/components/${ids.spl}/versions`, { calculationMethod: 'fixed', configuration: { balance: true }, effectiveFrom: '2030-01-01' });
    ids.vb = vb.body.data.id; ids.vh = vh.body.data.id; ids.vs = vs.body.data.id;
    for (const v of [ids.vb, ids.vh, ids.vs]) expect((await fin('post', `/compensation/component-versions/${v}/activate`)).body.data.status).toBe('active');
    expect((await fin('post', `/compensation/component-versions/${ids.vb}/activate`)).status).toBe(409);
  });
  it('validates versions', async () => {
    expect((await fin('post', `/compensation/components/${ids.hra}/versions`, { calculationMethod: 'percentage_of_component', effectiveFrom: '2030-01-01' })).status).toBe(422);
    expect((await fin('post', `/compensation/components/${ids.hra}/versions`, { calculationMethod: 'percentage_of_component', baseComponentCodes: ['NOPE'], defaultPercentage: '10', effectiveFrom: '2030-01-01' })).status).toBe(422);
    expect((await fin('post', `/compensation/components/${ids.hra}/versions`, { calculationMethod: 'percentage_of_component', baseComponentCodes: ['HRA'], defaultPercentage: '10', effectiveFrom: '2030-01-01' })).status).toBe(422);
    expect((await fin('post', `/compensation/components/${ids.hra}/versions`, { calculationMethod: 'manual', effectiveFrom: '2030-01-01' })).status).toBe(422);
  });
  it('creates, edits and activates a structure; active structures are frozen', async () => {
    const s = await fin('post', '/compensation/structures', { code: 'std', name: 'Standard', effectiveFrom: '2030-01-01', components: [
      { componentVersionId: ids.vb, displayOrder: 1 }, { componentVersionId: ids.vh, displayOrder: 2 }, { componentVersionId: ids.vs, displayOrder: 3 }] });
    expect(s.status).toBe(201); expect(s.body.data.components.map((c: { componentCode: string }) => c.componentCode)).toEqual(['BASIC', 'HRA', 'SPECIAL']);
    ids.st = s.body.data.id;
    expect((await fin('patch', `/compensation/structures/${ids.st}`, { name: 'Standard v1' })).body.data.name).toBe('Standard v1');
    expect((await fin('post', `/compensation/structures/${ids.st}/activate`)).body.data.status).toBe('active');
    expect((await fin('patch', `/compensation/structures/${ids.st}`, { name: 'x1' })).status).toBe(409);
    const nv = await fin('post', `/compensation/structures/${ids.st}/new-version`);
    expect(nv.status).toBe(201); expect(nv.body.data.version).toBe(2); expect(nv.body.data.components).toHaveLength(3);
  });
  it('rejects activation with draft component versions and duplicate components', async () => {
    const v2 = await fin('post', `/compensation/components/${ids.basic}/versions`, { calculationMethod: 'fixed', defaultAmount: '25000', effectiveFrom: '2031-01-01' });
    const s = await fin('post', '/compensation/structures', { code: 'dr', name: 'Draft test', effectiveFrom: '2030-01-01', components: [{ componentVersionId: v2.body.data.id }] });
    expect((await fin('post', `/compensation/structures/${s.body.data.id}/activate`)).status).toBe(409);
    const dup = await fin('post', '/compensation/structures', { code: 'dp', name: 'Dup test', effectiveFrom: '2030-01-01', components: [{ componentVersionId: ids.vb }, { componentVersionId: v2.body.data.id }] });
    expect(dup.status).toBe(422);
    expect((await fin('delete', `/compensation/component-versions/${ids.vb}`)).status).toBe(409);
    expect((await fin('delete', `/compensation/component-versions/${v2.body.data.id}`)).status).toBe(409);
  });
  it('is permission gated and tenant isolated', async () => {
    expect((await call('get', 'cpa-hr', A, '/compensation/components', undefined, { mfa: true })).status).toBe(403);
    expect((await call('post', 'cpa-hr', A, '/compensation/components', { code: 'X1', label: 'X1', componentType: 'earning' }, { mfa: true })).status).toBe(403);
    expect((await call('get', 'cpb-fin', B, '/compensation/components', undefined, { mfa: true })).body.data).toEqual([]);
    expect((await call('post', 'cpb-fin', B, `/compensation/components/${ids.basic}/versions`, { calculationMethod: 'fixed', defaultAmount: '1', effectiveFrom: '2030-01-01' }, { mfa: true })).status).toBe(404);
  });
});

describe('assignments (maker-checker)', () => {
  const propose = (o: object = {}) => fin('post', '/compensation/assignments', { employeeId: emp, salaryStructureId: ids.st, effectiveFrom: '2030-04-01', monthlyCtc: '50000.00', changeReason: 'Joining offer', ...o });
  it('proposes, cannot be self-approved, approved by approver', async () => {
    const p = await propose(); expect(p.status).toBe(201); expect(p.body.data.approvalStatus).toBe('pending'); ids.a1 = p.body.data.id;
    expect((await propose({ effectiveFrom: '2030-05-01' })).status).toBe(409); // one pending per employee
    expect((await call('post', 'cpa-fin', A, `/compensation/assignments/${ids.a1}/approve`, {}, { mfa: true })).status).toBe(403);
    expect((await call('get', 'cpa-appr', A, '/compensation/assignments/pending', undefined, { mfa: true })).body.data.map((x: { id: string }) => x.id)).toContain(ids.a1);
    const ok = await call('post', 'cpa-appr', A, `/compensation/assignments/${ids.a1}/approve`, { comment: 'ok' }, { mfa: true });
    expect(ok.status).toBe(200); expect(ok.body.data.approvalStatus).toBe('approved');
    expect((await call('post', 'cpa-appr', A, `/compensation/assignments/${ids.a1}/approve`, {}, { mfa: true })).status).toBe(409);
  });
  it('a later approved revision ends the earlier one the day before', async () => {
    const p = await propose({ effectiveFrom: '2030-10-01', monthlyCtc: '60000', changeReason: 'Annual increment' });
    expect(p.status).toBe(201);
    expect((await call('post', 'cpa-appr', A, `/compensation/assignments/${p.body.data.id}/approve`, {}, { mfa: true })).status).toBe(200);
    const list = (await fin('get', `/compensation/assignments?employeeId=${emp}`)).body.data;
    const first = list.find((x: { id: string }) => x.id === ids.a1);
    expect(first.effectiveTo).toBe('2030-09-30');
    expect(list.find((x: { id: string }) => x.id === p.body.data.id).effectiveTo).toBeNull();
  });
  it('rejects, validates overrides, hides other tenants', async () => {
    const bad = await propose({ effectiveFrom: '2031-01-01', overrides: [{ componentVersionId: ids.vb, amount: '1' }, { componentVersionId: '00000000-0000-4000-8000-000000000000', amount: '1' }] });
    expect(bad.status).toBe(422);
    const p = await propose({ effectiveFrom: '2031-02-01', changeReason: 'Wrong draft', overrides: [{ componentVersionId: ids.vb, amount: '30000' }] });
    expect(p.body.data.overrides).toHaveLength(1);
    expect((await call('post', 'cpa-appr', A, `/compensation/assignments/${p.body.data.id}/reject`, {}, { mfa: true })).body.data.approvalStatus).toBe('rejected');
    expect((await fin('post', '/compensation/assignments', { employeeId: empB, salaryStructureId: ids.st, effectiveFrom: '2030-04-01', monthlyCtc: '1', changeReason: 'cross tenant' })).status).toBe(404);
    expect((await call('post', 'cpa-fin', A, '/compensation/assignments', { employeeId: emp, salaryStructureId: '00000000-0000-4000-8000-000000000000', effectiveFrom: '2032-01-01', monthlyCtc: '1', changeReason: 'bad structure' }, { mfa: true })).status).toBe(422);
    expect((await call('get', 'cpa-emp', A, `/compensation/assignments?employeeId=${emp}`, undefined, { mfa: true })).status).toBe(403);
  });
});
