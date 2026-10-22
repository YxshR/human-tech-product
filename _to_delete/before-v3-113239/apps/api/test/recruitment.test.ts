import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let T: Tenant; let U: Tenant;
const ids: Record<string, string> = {};
type M = 'get' | 'post' | 'patch' | 'put' | 'delete';
const call = async (m: M, sub: string, t: Tenant, path: string, body?: object) => w.h.http()[m](path).set(await w.as(sub, t, { mfa: true })).send(body);
const rc = (m: M, p: string, b?: object) => call(m, 'rc-rec', T, p, b);
const hr = (m: M, p: string, b?: object) => call(m, 'rc-ca', T, p, b);   // company admin: reads candidates, but has no salary permission
let seq = 0;
const cand = (o: object = {}) => rc('post', '/candidates', { firstName: 'Cand', lastName: `N${++seq}`, email: `cand${seq}@example.com`, ...o });

beforeAll(async () => {
  w = await createWorld();
  T = await w.tenant('rc-a', 'rca-root'); U = await w.tenant('rc-b', 'rcb-root');
  await w.member(T, 'rca-root-boot', 'rc-rec', ['recruiter']);
  await w.member(T, 'rca-root-boot', 'rc-ca', ['company_admin']);
  await w.member(T, 'rca-root-boot', 'rc-emp', ['employee'], [T.branch]);
  await w.member(U, 'rcb-root-boot', 'rc-urec', ['recruiter']);
});
afterAll(() => w.close());

describe('clients & job requirements', () => {
  it('are managed by recruitment.manage and visible to recruiters', async () => {
    const c = await rc('post', '/clients', { code: 'acme', name: 'Acme Corp', contact: { name: 'Priya', email: 'Priya@Acme.com' } });
    expect(c.status).toBe(201); expect(c.body.data).toMatchObject({ code: 'ACME', status: 'active', contact: { email: 'priya@acme.com' } }); ids.client = c.body.data.id;
    expect((await rc('post', '/clients', { code: 'ACME', name: 'Dup' })).status).toBe(409);
    expect((await rc('post', '/clients', { code: 'x', name: 'Bad code' })).status).toBe(422);
    expect((await call('post', 'rc-emp', T, '/clients', { code: 'NOPE', name: 'x' })).status).toBe(403);
    expect((await call('get', 'rc-emp', T, '/clients')).status).toBe(403);
    expect((await rc('patch', `/clients/${ids.client}`, { status: 'inactive' })).body.data.status).toBe('inactive');
    expect((await rc('patch', `/clients/${ids.client}`, {})).status).toBe(422);
    expect((await rc('patch', `/clients/${ids.client}`, { status: 'active' })).body.data.status).toBe('active');
    expect((await call('get', 'rc-urec', U, '/clients')).body.data).toEqual([]);
    expect((await call('patch', 'rc-urec', U, `/clients/${ids.client}`, { name: 'hijack' })).status).toBe(404);
  });
  it('job requirements validate references and track fills', async () => {
    expect((await rc('post', '/job-requirements', { code: 'J1', title: 'Dev', clientId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
    expect((await rc('post', '/job-requirements', { code: 'J1', title: 'Dev', ownerUserId: w.users['rc-urec'] })).status).toBe(422);   // not a member of this tenant
    const j = await rc('post', '/job-requirements', { code: 'j1', title: 'Backend Developer', clientId: ids.client, location: 'Pune', openings: 2, ownerUserId: w.users['rc-rec'] });
    expect(j.status).toBe(201); expect(j.body.data).toMatchObject({ code: 'J1', openings: 2, filled: 0, status: 'open', closedAt: null }); ids.job = j.body.data.id;
    const one = await rc('post', '/job-requirements', { code: 'J2', title: 'Designer' }); ids.job1 = one.body.data.id;
    expect((await rc('post', '/job-requirements', { code: 'J1', title: 'Dup' })).status).toBe(409);
    expect((await rc('get', `/job-requirements?clientId=${ids.client}`)).body.data).toHaveLength(1);
    expect((await rc('patch', `/job-requirements/${ids.job}`, { status: 'filled' })).status).toBe(409);       // nobody has joined
    expect((await rc('patch', `/job-requirements/${ids.job}`, { status: 'on_hold' })).body.data.status).toBe('on_hold');
    const closed = await rc('patch', `/job-requirements/${ids.job1}`, { status: 'closed' });
    expect(closed.body.data.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await rc('patch', `/job-requirements/${ids.job1}`, { status: 'open' })).body.data.closedAt).toBeNull();
    expect((await call('get', 'rc-urec', U, `/job-requirements/${ids.job}`)).status).toBe(404);
  });
});

describe('candidates', () => {
  it('create normalises contact details and numbers candidates', async () => {
    const r = await cand({ firstName: 'Ravi', email: 'Ravi.K@Example.com', phone: '+91 98765-43210', city: 'Pune', source: 'Referral', clientId: ids.client, jobRequirementId: ids.job,
      totalExperienceMonths: 60, relevantExperienceMonths: 36, noticePeriodDays: 30, tags: ['Java', 'java', 'Backend'], currentCtc: '1200000.00', expectedCtc: '1500000' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ candidateCode: expect.stringMatching(/^CAN-\d{5}$/), email: 'ravi.k@example.com', phone: '+919876543210', stage: 'lead_new',
      tags: ['java', 'backend'], recruiterUserId: w.users['rc-rec'], currentCtc: '1200000.00', expectedCtc: '1500000.00', archived: false, version: 1 });
    ids.ravi = r.body.data.id;
    const hist = (await rc('get', `/candidates/${ids.ravi}/history`)).body.data;
    expect(hist).toHaveLength(1); expect(hist[0]).toMatchObject({ fromStage: null, toStage: 'lead_new' });
  });
  it('rejects bad input and duplicates', async () => {
    expect((await rc('post', '/candidates', { firstName: 'No contact' })).status).toBe(422);
    expect((await rc('post', '/candidates', { firstName: 'X', email: 'not-an-email' })).status).toBe(422);
    expect((await rc('post', '/candidates', { firstName: 'X', phone: 'abc' })).status).toBe(422);
    expect((await rc('post', '/candidates', { firstName: 'X', email: 'x@y.com', totalExperienceMonths: 10, relevantExperienceMonths: 20 })).status).toBe(422);
    expect((await rc('post', '/candidates', { firstName: 'X', email: 'x@y.com', surprise: 1 })).status).toBe(422);
    expect((await rc('post', '/candidates', { firstName: 'X', email: 'x@y.com', clientId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
    const dup = await rc('post', '/candidates', { firstName: 'Ravi2', email: 'RAVI.K@example.com' });
    expect(dup.status).toBe(409); expect(dup.body.error.message).toMatch(/CAN-/);
    expect((await rc('post', '/candidates', { firstName: 'Ravi3', phone: '+91 98765 43210' })).status).toBe(409);
    expect((await call('post', 'rc-urec', U, '/candidates', { firstName: 'Other tenant', email: 'ravi.k@example.com' })).status).toBe(201);   // uniqueness is per company
  });
  it('salary data is permissioned separately', async () => {
    const h = await hr('get', `/candidates/${ids.ravi}`);
    expect(h.status).toBe(200); expect(h.body.data).not.toHaveProperty('currentCtc'); expect(JSON.stringify(h.body)).not.toContain('1200000');
    expect((await hr('post', '/candidates', { firstName: 'Hr', email: 'hr.made@example.com', currentCtc: '100' })).status).toBe(403);
    expect((await hr('put', `/candidates/${ids.ravi}/compensation`, { currentCtc: '1', expectedCtc: '2' })).status).toBe(403);
    const s = await rc('put', `/candidates/${ids.ravi}/compensation`, { currentCtc: '1300000', expectedCtc: null });
    expect(s.body.data).toMatchObject({ currentCtc: '1300000.00', expectedCtc: null });
    expect((await rc('put', `/candidates/${ids.ravi}/compensation`, { currentCtc: '-5', expectedCtc: null })).status).toBe(422);
    const aud = (await w.admin.query(`SELECT after_redacted FROM audit_logs WHERE tenant_id=$1 AND action='candidate.salary_update'`, [T.id])).rows;
    expect(JSON.stringify(aud)).not.toMatch(/13000|1300000/);
    expect((await call('get', 'rc-emp', T, `/candidates/${ids.ravi}`)).status).toBe(403);
  });
  it('update uses optimistic versions and re-checks duplicates', async () => {
    const other = (await cand({ firstName: 'Sita', email: 'sita@example.com' })).body.data; ids.sita = other.id;
    expect((await rc('patch', `/candidates/${ids.sita}`, { version: 99, city: 'X' })).body.error.code).toBe('version_conflict');
    expect((await rc('patch', `/candidates/${ids.sita}`, { version: 1, email: 'ravi.k@example.com' })).status).toBe(409);
    expect((await rc('patch', `/candidates/${ids.sita}`, { version: 1, email: null })).status).toBe(422);                      // would leave no contact
    expect((await rc('patch', `/candidates/${ids.sita}`, { version: 1 })).status).toBe(422);
    const u = await rc('patch', `/candidates/${ids.sita}`, { version: 1, city: 'Chennai', phone: '98 1234 5678', tags: ['QA'], noticePeriodDays: 45 });
    expect(u.status).toBe(200); expect(u.body.data).toMatchObject({ city: 'Chennai', phone: '9812345678', tags: ['qa'], noticePeriodDays: 45, version: 2, email: 'sita@example.com' });
    await rc('patch', `/candidates/${ids.sita}`, { version: 2, totalExperienceMonths: 24 });
    expect((await rc('patch', `/candidates/${ids.sita}`, { version: 3, relevantExperienceMonths: 36 })).status).toBe(422);
  });
  it('lists with filters and cursor pagination', async () => {
    for (let i = 0; i < 4; i++) await cand({ firstName: `Page${i}`, source: 'paging' });
    const p1 = await rc('get', '/candidates?limit=3'); expect(p1.body.data).toHaveLength(3); expect(p1.body.page.nextCursor).toBeTruthy();
    const p2 = await rc('get', `/candidates?limit=3&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`);
    const seen = new Set([...p1.body.data, ...p2.body.data].map((x: { id: string }) => x.id)); expect(seen.size).toBe(p1.body.data.length + p2.body.data.length);
    const all: string[] = []; let cur: string | null = null;
    do { const r: { body: { data: Array<{ id: string }>; page: { nextCursor: string | null } } } = await rc('get', `/candidates?limit=2${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`); all.push(...r.body.data.map((x: { id: string }) => x.id)); cur = r.body.page.nextCursor; } while (cur);
    expect(new Set(all).size).toBe(all.length); expect(all.length).toBe((await w.admin.query(`SELECT count(*)::int n FROM candidates WHERE tenant_id=$1`, [T.id])).rows[0].n);
    expect((await rc('get', '/candidates?cursor=garbage')).status).toBe(422);
    expect((await rc('get', '/candidates?q=ravi')).body.data.map((x: { id: string }) => x.id)).toEqual([ids.ravi]);
    expect((await rc('get', '/candidates?q=%25')).body.data).toHaveLength(0);                                                  // wildcards are escaped
    expect((await rc('get', `/candidates?jobRequirementId=${ids.job}`)).body.data).toHaveLength(1);
    expect((await rc('get', '/candidates?stage=interview')).body.data).toHaveLength(0);
    expect((await rc('get', '/candidates?stage=bogus')).status).toBe(422);
    expect((await call('get', 'rc-urec', U, '/candidates')).body.data.every((x: { firstName: string }) => x.firstName === 'Other tenant')).toBe(true);
  });
  it('archive hides, restore brings back (and re-checks duplicates)', async () => {
    const x = (await cand({ firstName: 'Arch', email: 'arch@example.com' })).body.data;
    expect((await rc('post', `/candidates/${x.id}/archive`)).body.data.archived).toBe(true);
    expect((await rc('get', '/candidates?q=arch@')).body.data).toHaveLength(0);
    expect((await rc('get', '/candidates?archived=true')).body.data.map((c: { id: string }) => c.id)).toContain(x.id);
    expect((await rc('patch', `/candidates/${x.id}`, { version: x.version, city: 'Z' })).status).toBe(409);
    expect((await rc('post', `/candidates/${x.id}/stage`, { stage: 'contacted' })).status).toBe(409);
    expect((await cand({ firstName: 'Arch2', email: 'arch@example.com' })).status).toBe(201);                                  // email free again
    expect((await rc('post', `/candidates/${x.id}/restore`)).status).toBe(409);                                                 // ...so restoring now collides
  });
});

describe('pipeline stages', () => {
  it('enforces the state machine, reasons and history', async () => {
    const c = (await cand({ firstName: 'Flow', jobRequirementId: ids.job })).body.data; ids.flow = c.id;
    const st = (stage: string, reason?: string) => rc('post', `/candidates/${ids.flow}/stage`, { stage, ...(reason ? { reason } : {}) });
    expect((await st('lead_new')).status).toBe(409);
    expect((await st('contacted')).body.data.stage).toBe('contacted');
    expect((await st('interview')).body.data.stage).toBe('interview');                                  // forward may skip
    expect((await st('contacted')).status).toBe(422);                                                   // backward needs a reason
    expect((await st('submitted_to_client', 'client wants a re-screen')).body.data.stage).toBe('submitted_to_client');
    expect((await st('lead_new', 'x')).status).toBe(409);                                               // only one step back
    expect((await st('rejected')).status).toBe(422);
    const rej = await st('rejected', 'Salary mismatch'); expect(rej.body.data).toMatchObject({ stage: 'rejected', closureReason: 'Salary mismatch' });
    expect((await st('screening', 'second look')).status).toBe(409);                                    // rejected can only reopen to lead_new
    expect((await st('lead_new')).status).toBe(422);
    const re = await st('lead_new', 'Reapplied'); expect(re.body.data).toMatchObject({ stage: 'lead_new', closureReason: null });
    expect((await st('on_hold')).status).toBe(422);
    expect((await st('on_hold', 'Waiting for client')).body.data.stage).toBe('on_hold');
    expect((await st('screening')).body.data.stage).toBe('screening');                                  // hold resumes anywhere
    expect((await rc('post', `/candidates/${ids.flow}/stage`, { stage: 'joined' })).status).toBe(409);   // only via convert
    expect((await rc('post', `/candidates/${ids.flow}/stage`, { stage: 'nonsense' })).status).toBe(422);
    expect((await call('post', 'rc-emp', T, `/candidates/${ids.flow}/stage`, { stage: 'contacted' })).status).toBe(403);
    const hist = (await rc('get', `/candidates/${ids.flow}/history`)).body.data;
    expect(hist.map((h: { toStage: string }) => h.toStage)).toEqual(['lead_new', 'contacted', 'interview', 'submitted_to_client', 'rejected', 'lead_new', 'on_hold', 'screening']);
    expect(hist[4]).toMatchObject({ fromStage: 'submitted_to_client', reason: 'Salary mismatch', actorUserId: w.users['rc-rec'] });
    await expect(w.admin.query(`UPDATE candidate_stage_history SET reason='tamper' WHERE tenant_id=$1`, [T.id])).rejects.toThrow();   // append-only
  });
});

describe('activities & follow-ups', () => {
  it('tracks notes and the next follow-up', async () => {
    const n = await rc('post', `/candidates/${ids.sita}/activities`, { type: 'note', body: 'Strong on QA' }); expect(n.status).toBe(201);
    expect((await rc('post', `/candidates/${ids.sita}/activities`, { type: 'follow_up', body: 'Call back' })).status).toBe(422);
    expect((await rc('post', `/candidates/${ids.sita}/activities`, { type: 'note', body: 'x', dueAt: '2030-01-01T00:00:00Z' })).status).toBe(422);
    const f1 = (await rc('post', `/candidates/${ids.sita}/activities`, { type: 'follow_up', body: 'Call back', dueAt: '2030-02-01T10:00:00Z' })).body.data;
    const f2 = (await rc('post', `/candidates/${ids.sita}/activities`, { type: 'follow_up', body: 'Send JD', dueAt: '2030-01-15T10:00:00Z' })).body.data;
    expect((await rc('get', `/candidates/${ids.sita}`)).body.data.nextFollowUpAt).toBe('2030-01-15T10:00:00.000Z');
    expect((await rc('post', `/candidate-activities/${f2.id}/complete`)).body.data.completedAt).toBeTruthy();
    expect((await rc('get', `/candidates/${ids.sita}`)).body.data.nextFollowUpAt).toBe('2030-02-01T10:00:00.000Z');
    expect((await rc('post', `/candidate-activities/${f2.id}/complete`)).status).toBe(409);
    expect((await rc('post', `/candidate-activities/${n.body.data.id}/complete`)).status).toBe(404);                              // notes are not follow-ups
    await rc('post', `/candidate-activities/${f1.id}/complete`);
    expect((await rc('get', `/candidates/${ids.sita}`)).body.data.nextFollowUpAt).toBeNull();
    expect((await rc('get', `/candidates/${ids.sita}/activities`)).body.data).toHaveLength(3);
    await rc('post', `/candidates/${ids.sita}/activities`, { type: 'follow_up', body: 'Overdue', dueAt: '2020-01-01T00:00:00Z' });
    expect((await rc('get', '/candidates?followUpDue=true')).body.data.map((c: { id: string }) => c.id)).toEqual([ids.sita]);
    expect((await call('post', 'rc-urec', U, `/candidates/${ids.sita}/activities`, { type: 'note', body: 'x' })).status).toBe(404);
  });
});

describe('conversion to employee', () => {
  it('only a selected candidate converts, exactly once, and fills the requirement', async () => {
    const c = (await cand({ firstName: 'Joiner', lastName: 'One', email: 'joiner@example.com', phone: '9000000001', jobRequirementId: ids.job1 })).body.data;
    const body = { branchId: T.branch, joinedAt: '2026-11-01', employmentType: 'full_time' };
    expect((await rc('post', `/candidates/${c.id}/convert`, body)).status).toBe(409);                                             // still lead_new
    await rc('post', `/candidates/${c.id}/stage`, { stage: 'selected_offer' });
    expect((await call('post', 'rc-emp', T, `/candidates/${c.id}/convert`, body)).status).toBe(403);
    expect((await rc('post', `/candidates/${c.id}/convert`, { ...body, branchId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await rc('post', `/candidates/${c.id}/convert`, { ...body, joinedAt: 'tomorrow' })).status).toBe(422);
    const r = await rc('post', `/candidates/${c.id}/convert`, { ...body, workEmail: 'Joiner@Corp.com' });
    expect(r.status).toBe(201); expect(r.body.data.candidate).toMatchObject({ stage: 'joined', convertedEmployeeId: r.body.data.employeeId });
    const emp = (await w.admin.query(`SELECT employee_number, first_name, last_name, personal_email, work_email, phone, employment_status, to_char(joined_at,'YYYY-MM-DD') j, branch_id FROM employees WHERE id=$1`, [r.body.data.employeeId])).rows[0];
    expect(emp).toMatchObject({ employee_number: r.body.data.employeeNumber, first_name: 'Joiner', last_name: 'One', personal_email: 'joiner@example.com', work_email: 'joiner@corp.com', phone: '9000000001', employment_status: 'onboarding', j: '2026-11-01', branch_id: T.branch });
    expect((await rc('post', `/candidates/${c.id}/convert`, body)).status).toBe(409);
    expect((await rc('patch', `/candidates/${c.id}`, { version: r.body.data.candidate.version, city: 'X' })).status).toBe(409);
    expect((await rc('post', `/candidates/${c.id}/archive`)).status).toBe(409);
    expect((await rc('post', `/candidates/${c.id}/stage`, { stage: 'selected_offer', reason: 'undo' })).status).toBe(409);       // joined is terminal
    const job = (await rc('get', `/job-requirements/${ids.job1}`)).body.data;
    expect(job).toMatchObject({ filled: 1, status: 'filled' }); expect(job.closedAt).toBeTruthy();
    expect((await w.admin.query(`SELECT count(*)::int n FROM audit_logs WHERE tenant_id=$1 AND action='candidate.convert'`, [T.id])).rows[0].n).toBe(1);
  });
  it('a multi-opening requirement stays open until every seat is filled', async () => {
    const mk = async (n: number) => {
      const c = (await cand({ firstName: `Multi${n}`, jobRequirementId: ids.job })).body.data;
      await rc('post', `/candidates/${c.id}/stage`, { stage: 'selected_offer' });
      return rc('post', `/candidates/${c.id}/convert`, { branchId: T.branch, joinedAt: '2026-11-01' });
    };
    await rc('patch', `/job-requirements/${ids.job}`, { status: 'open' });
    expect((await mk(1)).status).toBe(201);
    expect((await rc('get', `/job-requirements/${ids.job}`)).body.data).toMatchObject({ filled: 1, status: 'open' });
    expect((await rc('patch', `/job-requirements/${ids.job}`, { openings: 0 })).status).toBe(422);
    expect((await mk(2)).status).toBe(201);
    expect((await rc('get', `/job-requirements/${ids.job}`)).body.data).toMatchObject({ filled: 2, status: 'filled' });
  });
});
