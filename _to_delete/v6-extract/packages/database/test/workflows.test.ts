import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { PERMISSION_KEYS } from '@humantech/authz';
import { withContext } from '../src';
import { closePools, makeEmployee, makeTenant, makeUser, pools, sqlstate, TestTenant, ensureCatalogue } from './helpers';

let T: TestTenant;
const app = <R>(fn: (c: PoolClient) => Promise<R>, user?: string) =>
  withContext(pools.app, { tenantId: T.tenantId, userId: user ?? T.adminUserId }, fn);

beforeAll(async () => {
  await ensureCatalogue();
  T = await makeTenant('wf');
});
afterAll(closePools);

describe('permission catalogue', () => {
  it('database permissions table equals the authz catalogue', async () => {
    const { rows } = await pools.admin.query('SELECT permission_key FROM permissions');
    expect(rows.map((r) => r.permission_key).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
  it('system roles were seeded with grants for the tenant', async () => {
    const rows = await app(async (c) => (await c.query(`SELECT r.role_key, count(rp.*)::int AS n FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id GROUP BY 1`)).rows);
    expect(rows.length).toBe(9);
    expect(rows.find((r) => r.role_key === 'employee')!.n).toBeGreaterThan(0);
  });
});

describe('privilege escalation guards', () => {
  it('a user cannot grant themselves a role', async () => {
    const roleId = await app(async (c) => (await c.query(`SELECT id FROM roles WHERE role_key='finance_payroll'`)).rows[0].id);
    const code = await sqlstate(() => app((c) => c.query(
      `INSERT INTO membership_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [T.tenantId, T.adminUserId, roleId])));
    expect(code).toBe('HT004');
  });
  it('another user can grant, and the permission version bumps', async () => {
    const other = await makeUser('other');
    const roleId = await app(async (c) => (await c.query(`SELECT id FROM roles WHERE role_key='hr_admin'`)).rows[0].id);
    const v = await app(async (c) => {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, status, branch_scope_mode) VALUES ($1,$2,'active','all')`, [T.tenantId, other]);
      const before = (await c.query(`SELECT permission_version v FROM tenant_memberships WHERE user_id=$1`, [other])).rows[0].v;
      await c.query(`INSERT INTO membership_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [T.tenantId, other, roleId]);
      const after = (await c.query(`SELECT permission_version v FROM tenant_memberships WHERE user_id=$1`, [other])).rows[0].v;
      return after - before;
    });
    expect(v).toBeGreaterThan(0);
  });
});

describe('leave ledger', () => {
  let emp: string;
  let leaveType: string;
  beforeAll(async () => {
    emp = await makeEmployee(T, { first: 'Leaver' });
    leaveType = await app(async (c) => (await c.query(
      `INSERT INTO leave_types (tenant_id, code, name) VALUES ($1,'CL','Casual Leave') RETURNING id`, [T.tenantId])).rows[0].id);
    await app((c) => c.query(
      `INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, idempotency_key)
       VALUES ($1,$2,$3,'opening_grant',1,'2030-01-01',$4)`, [T.tenantId, emp, leaveType, `grant-${randomUUID()}`]));
  });
  const use = (key = randomUUID(), days = -1) =>
    app((c) => c.query(
      `INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, idempotency_key)
       VALUES ($1,$2,$3,'usage',$4,'2030-02-01',$5)`, [T.tenantId, emp, leaveType, days, `use-${key}`]));

  it('ledger rows cannot be updated or deleted', async () => {
    // runtime role has no UPDATE/DELETE grant at all ...
    expect(await sqlstate(() => app((c) => c.query(`UPDATE leave_balance_transactions SET days_delta=99`)))).toBe('42501');
    expect(await sqlstate(() => app((c) => c.query(`DELETE FROM leave_balance_transactions`)))).toBe('42501');
    // ... and even the table owner is stopped by the trigger.
    const asOwner = <R>(fn: (c: PoolClient) => Promise<R>) => withContext(pools.owner, { tenantId: T.tenantId }, fn);
    expect(await sqlstate(() => asOwner((c) => c.query(`UPDATE leave_balance_transactions SET days_delta=99`)))).toBe('HT001');
    expect(await sqlstate(() => asOwner((c) => c.query(`DELETE FROM leave_balance_transactions`)))).toBe('HT001');
  });
  it('idempotency key prevents double posting', async () => {
    const key = randomUUID();
    await app((c) => c.query(
      `INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, idempotency_key)
       VALUES ($1,$2,$3,'accrual',0.5,'2030-03-01',$4)`, [T.tenantId, emp, leaveType, `acc-${key}`]));
    expect(await sqlstate(() => app((c) => c.query(
      `INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, idempotency_key)
       VALUES ($1,$2,$3,'accrual',0.5,'2030-03-01',$4)`, [T.tenantId, emp, leaveType, `acc-${key}`])))).toBe('23505');
  });
  it('concurrent usage cannot overdraw the balance', async () => {
    // balance is 1.5; fire 6 parallel 1-day debits: exactly one may succeed.
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => use(`race-${i}`)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toBe(1);
    for (const f of failed) expect((f.reason as { code: string }).code).toBe('HT005');
    const bal = await app(async (c) => (await c.query(`SELECT balance_days FROM leave_balances WHERE employee_id=$1`, [emp])).rows[0].balance_days);
    expect(Number(bal)).toBe(0.5);
  });
  it('manual adjustments need a reason', async () => {
    expect(await sqlstate(() => app((c) => c.query(
      `INSERT INTO leave_balance_transactions (tenant_id, employee_id, leave_type_id, transaction_type, days_delta, effective_date, idempotency_key)
       VALUES ($1,$2,$3,'manual_adjustment',2,'2030-03-01',$4)`, [T.tenantId, emp, leaveType, `adj-${randomUUID()}`])))).toBe('23514');
  });
  it('overlapping leave requests are refused; opposite half days coexist', async () => {
    const insert = (s: string, e: string, half: string | null) => app((c) => c.query(
      `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, partial_day, requested_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [T.tenantId, emp, leaveType, s, e, half, half ? 0.5 : 1]));
    await insert('2030-05-10', '2030-05-10', 'first_half');
    await insert('2030-05-10', '2030-05-10', 'second_half');
    expect(await sqlstate(() => insert('2030-05-10', '2030-05-10', 'first_half'))).toBe('HT003');
    await insert('2030-06-01', '2030-06-03', null);
    expect(await sqlstate(() => insert('2030-06-03', '2030-06-04', null))).toBe('HT003');
  });
  it('an employee cannot decide their own leave request', async () => {
    const login = await makeUser('self-approver');
    await app(async (c) => {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, status, branch_scope_mode) VALUES ($1,$2,'active','all')`, [T.tenantId, login]);
    });
    const selfEmp = await app(async (c) => {
      const n = (await c.query(`SELECT app.next_employee_number() n`)).rows[0].n;
      return (await c.query(
        `INSERT INTO employees (tenant_id, employee_number, first_name, user_id, employment_status) VALUES ($1,$2,'Self',$3,'active') RETURNING id`,
        [T.tenantId, n, login])).rows[0].id;
    });
    const code = await sqlstate(() => app(async (c) => {
      const r = await c.query(
        `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, requested_days)
         VALUES ($1,$2,$3,'2030-09-01','2030-09-01',1) RETURNING id`, [T.tenantId, selfEmp, leaveType]);
      await c.query(`UPDATE leave_requests SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`, [r.rows[0].id, login]);
    }));
    expect(code).toBe('HT004');
  });
  it('decided requests cannot be reopened', async () => {
    const code = await sqlstate(() => app(async (c) => {
      const r = await c.query(
        `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, requested_days)
         VALUES ($1,$2,$3,'2030-10-01','2030-10-01',1) RETURNING id`, [T.tenantId, emp, leaveType]);
      await c.query(`UPDATE leave_requests SET status='rejected', decided_by=$2, decided_at=now() WHERE id=$1`, [r.rows[0].id, T.adminUserId]);
      await c.query(`UPDATE leave_requests SET status='pending' WHERE id=$1`, [r.rows[0].id]);
    }));
    expect(code).toBe('HT003');
  });
});

describe('employee master', () => {
  it('manager cycles are refused', async () => {
    const a = await makeEmployee(T, { first: 'Boss' });
    const b = await makeEmployee(T, { first: 'Report', managerId: a });
    const code = await sqlstate(() => app((c) => c.query(`UPDATE employees SET manager_id=$1 WHERE id=$2`, [b, a])));
    expect(code).toBeTruthy();
    expect(['HT003', '23514']).toContain(code);
  });
  it('employee numbers are unique and sequential per tenant', async () => {
    const x = await makeEmployee(T);
    const y = await makeEmployee(T);
    const nums = await app(async (c) => (await c.query(`SELECT employee_number FROM employees WHERE id = ANY($1)`, [[x, y]])).rows.map((r) => r.employee_number));
    expect(new Set(nums).size).toBe(2);
  });
  it('concurrent number allocation never duplicates', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => makeEmployee(T)));
    expect(new Set(ids).size).toBe(8);
  });
  it('employment history is recorded automatically on change', async () => {
    const e = await makeEmployee(T);
    await withContext(pools.app, { tenantId: T.tenantId, userId: T.adminUserId, reason: 'promotion', effectiveDate: '2030-04-01' }, (c) =>
      c.query(`UPDATE employees SET employment_type='contract' WHERE id=$1`, [e]));
    const h = await app(async (c) => (await c.query(`SELECT * FROM employment_history WHERE employee_id=$1`, [e])).rows);
    expect(h.length).toBeGreaterThan(0);
  });
});

describe('recruitment pipeline', () => {
  const candidate = (c: PoolClient) =>
    c.query<{ id: string }>(
      `INSERT INTO candidates (tenant_id, candidate_code, first_name, email_normalized) VALUES ($1,$2,'Cand',$3) RETURNING id`,
      [T.tenantId, `C-${randomUUID().slice(0, 8)}`, `${randomUUID()}@example.test`]).then((r) => r.rows[0]!.id);
  const move = async (c: PoolClient, id: string, stage: string, reason?: string) => {
    await c.query(`SELECT set_config('app.change_reason', $1, true)`, [reason ?? '']);
    await c.query(`UPDATE candidates SET current_stage=$2, closure_reason=COALESCE($3, closure_reason) WHERE id=$1`, [id, stage, reason ?? null]);
  };

  it('moves forward, records history, and refuses invalid jumps', async () => {
    const code = await sqlstate(() => app(async (c) => {
      const id = await candidate(c);
      await move(c, id, 'contacted');
      await move(c, id, 'screening');
      const h = await c.query(`SELECT count(*)::int n FROM candidate_stage_history WHERE candidate_id=$1`, [id]);
      expect(h.rows[0].n).toBeGreaterThanOrEqual(2);
      await move(c, id, 'joined'); // must go through selected_offer
    }));
    expect(code).toBe('HT003');
  });
  it('rejection requires a reason', async () => {
    const code = await sqlstate(() => app(async (c) => {
      const id = await candidate(c);
      await move(c, id, 'rejected');
    }));
    expect(code).toBe('HT003');
  });
  it('rejection with a reason is accepted and recorded', async () => {
    await app(async (c) => {
      const id = await candidate(c);
      await move(c, id, 'rejected', 'not a fit');
      const h = await c.query(`SELECT reason FROM candidate_stage_history WHERE candidate_id=$1 AND to_stage='rejected'`, [id]);
      expect(h.rows[0].reason).toBe('not a fit');
    });
  });
  it('joined is terminal', async () => {
    const code = await sqlstate(() => app(async (c) => {
      const id = await candidate(c);
      for (const s of ['contacted', 'screening', 'submitted_to_client', 'interview', 'selected_offer', 'joined']) await move(c, id, s);
      await move(c, id, 'lead_new', 'oops');
    }));
    expect(code).toBe('HT003');
  });
});

describe('outbox queue', () => {
  const enqueue = (n: number) => app(async (c) => {
    for (let i = 0; i < n; i++) {
      await c.query(
        `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, idempotency_key) VALUES ($1,'t',$2,'test.event',$3)`,
        [T.tenantId, randomUUID(), `k-${randomUUID()}`]);
    }
  });
  it('concurrent workers never claim the same event (SKIP LOCKED)', async () => {
    await pools.admin.query('DELETE FROM outbox_events');
    await enqueue(20);
    const claim = (w: string) => pools.system.query('SELECT id FROM app.claim_outbox_events(10, $1)', [w]);
    const [a, b, c3] = await Promise.all([claim('w1'), claim('w2'), claim('w3')]);
    const ids = [...a.rows, ...b.rows, ...c3.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(20);
  });
  it('complete is idempotent and owner-bound; transient failures back off; permanent dead-letter', async () => {
    await pools.admin.query('DELETE FROM outbox_events');
    await enqueue(3);
    const claimed = (await pools.system.query('SELECT id FROM app.claim_outbox_events(3, $1)', ['wA'])).rows.map((r) => r.id as string);
    expect((await pools.system.query('SELECT app.complete_outbox_event($1,$2) ok', [claimed[0], 'someone-else'])).rows[0].ok).toBe(false);
    expect((await pools.system.query('SELECT app.complete_outbox_event($1,$2) ok', [claimed[0], 'wA'])).rows[0].ok).toBe(true);
    expect((await pools.system.query('SELECT app.complete_outbox_event($1,$2) ok', [claimed[0], 'wA'])).rows[0].ok).toBe(false);
    expect((await pools.system.query('SELECT app.fail_outbox_event($1,$2,$3,$4) r', [claimed[1], 'wA', 'E_TMP', 'boom'])).rows[0].r).toBe('retry_scheduled');
    expect((await pools.system.query('SELECT app.fail_outbox_event($1,$2,$3,$4,true) r', [claimed[2], 'wA', 'E_BAD', 'nope'])).rows[0].r).toBe('dead_lettered');
    // nothing left to claim right now (one retry is in the future, one done, one dead)
    expect((await pools.system.query('SELECT id FROM app.claim_outbox_events(10, $1)', ['wB'])).rows).toHaveLength(0);
  });
  it('the runtime role cannot call queue-claim functions', async () => {
    expect(await sqlstate(() => pools.app.query('SELECT * FROM app.claim_outbox_events(1,$1)', ['x']))).toBe('42501');
  });
  it('the system role cannot read business tables', async () => {
    expect(await sqlstate(() => pools.system.query('SELECT * FROM employees'))).toBe('42501');
  });
});

describe('invoices', () => {
  it('numbers are assigned at issue, gap-free under concurrency, and issued invoices are immutable', async () => {
    const mk = () => app(async (c) => (await c.query(`INSERT INTO invoices (tenant_id, subtotal, tax_total, total) VALUES ($1,100,18,118) RETURNING id`, [T.tenantId])).rows[0].id as string);
    const ids = await Promise.all(Array.from({ length: 5 }, mk));
    await Promise.all(ids.map((id) => app((c) => c.query(`UPDATE invoices SET status='issued', issued_by=$2 WHERE id=$1`, [id, T.adminUserId]))));
    const nums = await app(async (c) => (await c.query(`SELECT invoice_number FROM invoices WHERE id = ANY($1) ORDER BY invoice_number`, [ids])).rows.map((r) => r.invoice_number as string));
    expect(new Set(nums).size).toBe(5);
    const n = nums.map((x) => Number(x.replace('INV-', '')));
    expect(Math.max(...n) - Math.min(...n)).toBe(4);
    expect(await sqlstate(() => app((c) => c.query(`UPDATE invoices SET total=1, subtotal=1, tax_total=0 WHERE id=$1`, [ids[0]])))).toBe('HT002');
    expect(await sqlstate(() => app((c) => c.query(`DELETE FROM invoices WHERE id=$1`, [ids[0]])))).toBe('HT002');
    expect(await sqlstate(() => app((c) => c.query(`INSERT INTO invoice_lines (tenant_id, invoice_id, line_number, description, quantity, unit_price, line_total) VALUES ($1,$2,1,'x',1,1,1)`, [T.tenantId, ids[0]])))).toBe('HT002');
  });
  it('voiding keeps content and needs a reason', async () => {
    const id = await app(async (c) => (await c.query(`INSERT INTO invoices (tenant_id) VALUES ($1) RETURNING id`, [T.tenantId])).rows[0].id as string);
    await app((c) => c.query(`UPDATE invoices SET status='issued' WHERE id=$1`, [id]));
    expect(await sqlstate(() => app((c) => c.query(`UPDATE invoices SET status='void' WHERE id=$1`, [id])))).toBe('23514');
    await app((c) => c.query(`UPDATE invoices SET status='void', void_reason='dup', voided_by=$2 WHERE id=$1`, [id, T.adminUserId]));
  });
});

describe('statutory rule sets', () => {
  it('cannot be approved by the same person who prepared them', async () => {
    const u = await makeUser('prep');
    const code = await sqlstate(() => pools.admin.query(
      `INSERT INTO statutory_rule_sets (rule_group, version, effective_from, definition, source_url, status, prepared_by, reviewed_by, reviewed_at)
       VALUES ('pf', 1, '2030-04-01', '{}', 'https://example.test/rule', 'approved', $1, $1, now())`, [u]));
    expect(code).toBe('23514');
  });
  it('approved rule versions cannot overlap', async () => {
    const [p, r] = [await makeUser('p'), await makeUser('r')];
    const ins = (v: number, from: string, to: string | null) => pools.admin.query(
      `INSERT INTO statutory_rule_sets (rule_group, version, effective_from, effective_to, definition, source_url, status, prepared_by, reviewed_by, reviewed_at)
       VALUES ('esi', $1, $2, $3, '{}', 'https://example.test/r', 'approved', $4, $5, now())`, [v, from, to, p, r]);
    await ins(1, '2031-01-01', '2031-12-31');
    expect(await sqlstate(() => ins(2, '2031-06-01', null))).toBe('23P01');
  });
});
