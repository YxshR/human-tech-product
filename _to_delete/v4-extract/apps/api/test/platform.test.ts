import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { World, Tenant, createWorld } from './fixtures';

let w: World; let T: Tenant; let U: Tenant;
let e1: string;
const ids: Record<string, string> = {};
type M = 'get' | 'post' | 'put';
const call = async (m: M, sub: string, t: Tenant, path: string, body?: object) => w.h.http()[m](path).set(await w.as(sub, t, { mfa: true })).send(body);
const hr = (m: M, p: string, b?: object) => call(m, 'pl-hr', T, p, b);

beforeAll(async () => {
  w = await createWorld();
  T = await w.tenant('pl-a', 'pla-root'); U = await w.tenant('pl-b', 'plb-root');
  await w.member(T, 'pla-root-boot', 'pl-hr', ['hr_admin']);
  await w.member(T, 'pla-root-boot', 'pl-hr1', ['hr_admin'], [T.branch]);           // HR for branch 1 only
  await w.member(T, 'pla-root-boot', 'pl-rec', ['recruiter']);
  await w.member(T, 'pla-root-boot', 'pl-e1', ['employee'], [T.branch]);
  await w.member(T, 'pla-root-boot', 'pl-e2', ['employee'], [T.branch]);
  await w.member(U, 'plb-root-boot', 'pl-uhr', ['hr_admin']);
  e1 = await w.employee(T, 'pla-root-boot', 'pl-e1', { joined: '2024-01-01', name: 'Asha' });
  await w.employee(T, 'pla-root-boot', 'pl-e2', { joined: '2024-01-01', name: '=HYPERLINK("x")' });
  await w.employee(T, 'pla-root-boot', null, { joined: '2024-02-01', name: 'Branch Two', branch: T.branch2 });
});
afterAll(() => w.close());

describe('notifications', () => {
  it('a decision on your request tells you, and only you', async () => {
    const r = await call('post', 'pl-e1', T, '/profile-changes', { changes: { phone: '+91 90000 11111' } });
    expect((await hr('post', `/profile-changes/${r.body.data.id}/approve`, { comment: 'verified' })).status).toBe(200);
    const mine = await call('get', 'pl-e1', T, '/me/notifications');
    expect(mine.body.unread).toBe(1); expect(mine.body.data[0]).toMatchObject({ eventKey: 'profile_change.approved', title: 'Your profile change request was approved', body: 'verified', readAt: null });
    ids.n1 = mine.body.data[0].id;
    expect((await call('get', 'pl-e2', T, '/me/notifications')).body.data).toEqual([]);
    expect((await call('post', 'pl-e2', T, `/me/notifications/${ids.n1}/read`)).status).toBe(404);          // not yours
    expect((await call('post', 'pl-uhr', U, `/me/notifications/${ids.n1}/read`)).status).toBe(404);
    expect((await call('post', 'pl-e1', T, `/me/notifications/${ids.n1}/read`)).body.data.readAt).toBeTruthy();
    expect((await call('get', 'pl-e1', T, '/me/notifications?unread=true')).body.data).toEqual([]);
    expect((await call('get', 'pl-e1', T, '/me/notifications')).body.unread).toBe(0);
  });
  it('pages newest-first with a cursor and can mark everything read', async () => {
    const uid = w.users['pl-e2'];
    for (let i = 0; i < 5; i++) await w.admin.query(`INSERT INTO notifications (tenant_id, recipient_user_id, event_key, title) VALUES ($1,$2,'payslip.ready',$3)`, [T.id, uid, `n${i}`]);
    const p1 = await call('get', 'pl-e2', T, '/me/notifications?limit=2'); expect(p1.body.data.map((n: { title: string }) => n.title)).toEqual(['n4', 'n3']);
    const p2 = await call('get', 'pl-e2', T, `/me/notifications?limit=2&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`); expect(p2.body.data.map((n: { title: string }) => n.title)).toEqual(['n2', 'n1']);
    const p3 = await call('get', 'pl-e2', T, `/me/notifications?limit=2&cursor=${encodeURIComponent(p2.body.page.nextCursor)}`); expect(p3.body.data.map((n: { title: string }) => n.title)).toEqual(['n0']); expect(p3.body.page.nextCursor).toBeNull();
    expect((await call('get', 'pl-e2', T, '/me/notifications?cursor=junk')).status).toBe(422);
    expect((await call('post', 'pl-e2', T, '/me/notifications/read-all')).body.data.updated).toBe(5);
    expect((await call('get', 'pl-e2', T, '/me/notifications')).body.unread).toBe(0);
  });
  it('preferences can silence an event type', async () => {
    const list = (await call('get', 'pl-e1', T, '/me/notification-preferences')).body.data;
    expect(list.map((p: { eventKey: string }) => p.eventKey)).toContain('payslip.ready'); expect(list.every((p: { inAppEnabled: boolean }) => p.inAppEnabled)).toBe(true);
    expect((await call('put', 'pl-e1', T, '/me/notification-preferences/profile_change.approved', { inAppEnabled: false })).body.data).toMatchObject({ inAppEnabled: false, emailEnabled: true });
    expect((await call('put', 'pl-e1', T, '/me/notification-preferences/nope.nope', { inAppEnabled: false })).status).toBe(404);
    expect((await call('put', 'pl-e1', T, '/me/notification-preferences/leave.approved', {})).status).toBe(422);
    const before = (await call('get', 'pl-e1', T, '/me/notifications')).body.data.length;
    const r = await call('post', 'pl-e1', T, '/profile-changes', { changes: { phone: '+91 90000 22222' } });
    await hr('post', `/profile-changes/${r.body.data.id}/approve`, {});
    expect((await call('get', 'pl-e1', T, '/me/notifications')).body.data).toHaveLength(before);       // silenced
    await call('put', 'pl-e1', T, '/me/notification-preferences/profile_change.approved', { inAppEnabled: true });
  });
});

describe('audit viewer', () => {
  it('shows who did what, filterable and paged; employees cannot read it', async () => {
    expect((await call('get', 'pl-e1', T, '/audit-logs')).status).toBe(403);
    const all = await hr('get', '/audit-logs?limit=100'); expect(all.status).toBe(200);
    const row = all.body.data.find((r: { action: string; reason: string | null }) => r.action === 'profile_change.approve' && r.reason === 'verified');
    expect(row).toMatchObject({ entityType: 'profile_change_requests', actorUserId: w.users['pl-hr'], actorName: 'pl-hr', reason: 'verified' });
    expect(JSON.stringify(all.body)).not.toContain('90000 11111');                                  // redacted at write time
    expect((await hr('get', '/audit-logs?action=profile_change.')).body.data.every((r: { action: string }) => r.action.startsWith('profile_change.'))).toBe(true);
    expect((await hr('get', '/audit-logs?action=%25')).body.data).toEqual([]);                      // wildcard is escaped
    expect((await hr('get', `/audit-logs?actorUserId=${w.users['pl-e1']}`)).body.data.every((r: { actorUserId: string }) => r.actorUserId === w.users['pl-e1'])).toBe(true);
    expect((await hr('get', '/audit-logs?from=2020-01-01&to=2020-01-02')).body.data).toEqual([]);
    expect((await hr('get', '/audit-logs?from=junk')).status).toBe(422);
    const p1 = await hr('get', '/audit-logs?limit=3'); const p2 = await hr('get', `/audit-logs?limit=3&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`);
    expect(p1.body.data).toHaveLength(3); expect(p2.body.data.every((r: { id: string }) => !p1.body.data.some((x: { id: string }) => x.id === r.id))).toBe(true);
    expect((await call('get', 'pl-uhr', U, '/audit-logs?limit=100')).body.data.some((r: { action: string }) => r.action === 'profile_change.approve')).toBe(false);   // other company
  });
  it('is append-only even for the database owner', async () => {
    await expect(w.admin.query(`UPDATE audit_logs SET reason='x'`)).rejects.toThrow(/append-only|append only/i);
    await expect(w.admin.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only|append only/i);
  });
});

describe('reports', () => {
  it('the catalogue follows permissions', async () => {
    expect((await hr('get', '/reports')).body.data.map((r: { key: string }) => r.key)).toEqual(['headcount', 'employees', 'attendance_summary', 'leave_balances']);
    expect((await call('get', 'pl-rec', T, '/reports')).body.data.map((r: { key: string }) => r.key)).toEqual(['hiring_funnel', 'candidates']);
    expect((await call('get', 'pl-e1', T, '/reports')).status).toBe(403);
    expect((await call('get', 'pl-rec', T, '/reports/headcount')).status).toBe(403);
    expect((await hr('get', '/reports/nonsense')).status).toBe(404);
  });
  it('headcount respects branch scope', async () => {
    const all = (await hr('get', '/reports/headcount')).body.data;
    expect(all.rows.reduce((n: number, r: { employees: number }) => n + r.employees, 0)).toBe(3);
    const b1 = (await call('get', 'pl-hr1', T, '/reports/headcount')).body.data;
    expect(b1.rows.reduce((n: number, r: { employees: number }) => n + r.employees, 0)).toBe(2);
    expect((await call('get', 'pl-hr1', T, `/reports/headcount?branchId=${T.branch2}`)).status).toBe(404);
    expect((await hr('get', `/reports/headcount?branchId=${T.branch2}`)).body.data.rows).toHaveLength(1);
    expect((await hr('get', '/reports/headcount?status=active')).body.data.rows.every((r: { status: string }) => r.status === 'active')).toBe(true);
    expect((await hr('get', '/reports/headcount?bogus=1')).status).toBe(422);
  });
  it('employee list hides personal contact details', async () => {
    const r = (await hr('get', '/reports/employees')).body.data;
    expect(r.rows).toHaveLength(3); expect(r.columns.map((c: { key: string }) => c.key)).not.toContain('phone'); expect(JSON.stringify(r.rows)).not.toContain('90000');
    expect((await call('get', 'pl-hr1', T, '/reports/employees')).body.data.rows.map((x: { name: string }) => x.name)).not.toContain('Branch Two');
  });
  it('attendance summary and leave balances compute from the source tables', async () => {
    expect((await hr('get', '/reports/attendance_summary')).status).toBe(422);
    expect((await hr('get', '/reports/attendance_summary?from=2026-09-10&to=2026-09-01')).status).toBe(422);
    expect((await hr('get', '/reports/attendance_summary?from=2020-01-01&to=2026-09-01')).status).toBe(422);
    await w.admin.query(`INSERT INTO attendance_days (tenant_id, employee_id, work_date, attendance_status, paid_day_fraction, late_minutes) VALUES
      ($1,$2,'2026-09-01','present',1,10), ($1,$2,'2026-09-02','present',1,5), ($1,$2,'2026-09-03','absent',0,0), ($1,$2,'2026-09-04','leave',1,0), ($1,$2,'2026-10-01','present',1,0)`, [T.id, e1]);
    const a = (await hr('get', '/reports/attendance_summary?from=2026-09-01&to=2026-09-30')).body.data.rows;
    expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ name: 'Asha', present: 2, absent: 1, leave: 1, lateMinutes: 15 });
    const lt = (await w.admin.query(`INSERT INTO leave_types (tenant_id, code, name) VALUES ($1,'CL','Casual leave') RETURNING id`, [T.id])).rows[0].id;
    await w.admin.query(`INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, idempotency_key) VALUES
      ($1,$2,$3,'opening_grant',12,'2026-01-01','t1'), ($1,$2,$3,'usage',-2.5,'2026-03-01','t2'), ($1,$2,$3,'accrual',1,'2026-06-01','t3')`, [T.id, e1, lt]);
    expect((await hr('get', '/reports/leave_balances?asOf=2026-04-01')).body.data.rows[0]).toMatchObject({ name: 'Asha', leaveType: 'CL', balance: '9.500' });
    expect((await hr('get', '/reports/leave_balances?asOf=2026-12-31')).body.data.rows[0].balance).toBe('10.500');
  });
  it('hiring funnel and candidate list for recruiters', async () => {
    const c = await call('post', 'pl-rec', T, '/candidates', { firstName: 'Fun', email: 'fun@example.com', currentCtc: '100' });
    await call('post', 'pl-rec', T, `/candidates/${c.body.data.id}/stage`, { stage: 'contacted' });
    await call('post', 'pl-rec', T, '/candidates', { firstName: 'Two', email: 'two@example.com' });
    const f = (await call('get', 'pl-rec', T, '/reports/hiring_funnel')).body.data.rows;
    expect(f.find((r: { stage: string }) => r.stage === 'contacted').candidates).toBe(1); expect(f.find((r: { stage: string }) => r.stage === 'lead_new').candidates).toBe(1);
    const list = (await call('get', 'pl-rec', T, '/reports/candidates?status=contacted')).body.data;
    expect(list.rows).toHaveLength(1); expect(JSON.stringify(list)).not.toMatch(/ctc|salary/i);
  });
  it('CSV downloads follow export rules and defuse spreadsheet formulas', async () => {
    const r = await w.h.http().get('/reports/employees?format=csv').set(await w.as('pl-hr', T, { mfa: true }));
    expect(r.status).toBe(200); expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text.split('\r\n')[0]).toBe('Employee no.,Name,Work email,Status,Type,Branch,Department,Joined');
    expect(r.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect((await w.h.http().get('/reports/headcount?format=csv').set(await w.as('pl-e1', T, { mfa: true }))).status).toBe(403);
    const audit = (await hr('get', '/audit-logs?action=report.download_csv')).body.data; expect(audit.length).toBeGreaterThan(0);
  });
});

describe('stored exports', () => {
  it('creates a private, expiring file that only the requester can download', async () => {
    const x = await hr('post', '/exports', { reportKey: 'employees', filters: { status: 'active' } });
    expect(x.status).toBe(201); expect(x.body.data).toMatchObject({ reportKey: 'employees', format: 'csv', status: 'completed', rowCount: 3 }); ids.x = x.body.data.id;
    const dl = await w.h.http().get(x.body.data.downloadUrl).set(await w.as('pl-hr', T));
    expect(dl.status).toBe(200); expect(dl.text.split('\r\n').length).toBe(5);          // header + 3 rows + trailing blank
    expect((await w.h.http().get(x.body.data.downloadUrl).set(await w.as('pl-hr1', T))).status).toBe(404);
    expect((await call('get', 'pl-hr1', T, `/exports/${ids.x}/download-link`)).status).toBe(404);
    expect((await hr('get', `/exports/${ids.x}/download-link`)).status).toBe(200);
    expect((await hr('get', '/exports')).body.data.map((e: { id: string }) => e.id)).toContain(ids.x);
    await w.admin.query(`UPDATE export_jobs SET expires_at=now() - interval '1 minute' WHERE id=$1`, [ids.x]);
    expect((await hr('get', `/exports/${ids.x}/download-link`)).status).toBe(409);
    const evs = (await w.admin.query(`SELECT action FROM file_access_events WHERE file_id=(SELECT result_file_id FROM export_jobs WHERE id=$1) ORDER BY created_at`, [ids.x])).rows.map((r) => r.action);
    expect(evs.slice(0, 2)).toEqual(['download_url_issued', 'download']);
  });
  it('is gated by export permissions per report', async () => {
    expect((await call('post', 'pl-e1', T, '/exports', { reportKey: 'headcount' })).status).toBe(403);
    expect((await hr('post', '/exports', { reportKey: 'hiring_funnel' })).status).toBe(403);       // HR lacks candidate.read
    expect((await call('post', 'pl-rec', T, '/exports', { reportKey: 'candidates' })).status).toBe(201);
    expect((await hr('post', '/exports', { reportKey: 'nope' })).status).toBe(422);
    expect((await hr('post', '/exports', { reportKey: 'attendance_summary' })).status).toBe(422);   // missing range
    expect((await call('get', 'pl-uhr', U, `/exports/${ids.x}/download-link`)).status).toBe(404);
  });
});
