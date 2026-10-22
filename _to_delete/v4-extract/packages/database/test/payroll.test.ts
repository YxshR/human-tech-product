import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PoolClient } from 'pg';
import { makeEmployee, makeTenant, makeUser, pools, closePools, sqlstate, TestTenant } from './helpers';
import { withContext } from '../src';

let T: TestTenant;
let maker: string;
let checker: string;
let groupId: string;
let periodN = 0;

const asApp = <R>(fn: (c: PoolClient) => Promise<R>, user = maker) =>
  withContext(pools.app, { tenantId: T.tenantId, userId: user }, fn);

async function newPeriod(c: PoolClient): Promise<string> {
  periodN += 1;
  const year = 2040 + Math.floor((periodN - 1) / 12);
  const m = String(((periodN - 1) % 12) + 1).padStart(2, '0');
  const r = await c.query<{ id: string }>(
    `INSERT INTO payroll_periods (tenant_id, pay_group_id, period_code, period_start, period_end)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [T.tenantId, groupId, `${year}-${m}`, `${year}-${m}-01`, `${year}-${m}-28`],
  );
  return r.rows[0]!.id;
}
async function newRun(c: PoolClient, periodId: string): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO payroll_runs (tenant_id, payroll_period_id, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [T.tenantId, periodId, maker],
  );
  return r.rows[0]!.id;
}
const setStatus = (c: PoolClient, id: string, status: string, extra = '') =>
  c.query(`UPDATE payroll_runs SET status='${status}' ${extra} WHERE id=$1`, [id]);

/** Drive a run to `calculated` with one reconciled item + lines. */
async function calculatedRun(c: PoolClient, empId: string): Promise<string> {
  const p = await newPeriod(c);
  const run = await newRun(c, p);
  await setStatus(c, run, 'validated');
  const item = await c.query<{ id: string }>(
    `INSERT INTO payroll_run_items (tenant_id, payroll_run_id, employee_id, input_snapshot, gross_earnings, employee_deductions, employer_contributions, net_pay)
     VALUES ($1,$2,$3,'{}',50000.00,1800.00,1800.00,48200.00) RETURNING id`,
    [T.tenantId, run, empId],
  );
  for (const [code, type, amt] of [['BASIC', 'earning', '50000.00'], ['PF_EE', 'employee_deduction', '1800.00'], ['PF_ER', 'employer_contribution', '1800.00']]) {
    await c.query(
      `INSERT INTO payroll_line_items (tenant_id, payroll_run_item_id, component_code, component_label_snapshot, component_type, calculation_method, amount)
       VALUES ($1,$2,$3,$3,$4,'fixed',$5)`,
      [T.tenantId, item.rows[0]!.id, code, type, amt],
    );
  }
  await c.query(
    `UPDATE payroll_runs SET total_gross=50000, total_employee_deductions=1800, total_employer_contributions=1800, total_net_pay=48200,
       engine_version='0.1.0', input_hash='h', rule_bundle_hash='r', status='calculated' WHERE id=$1`, [run]);
  return run;
}

let emp: string;
beforeAll(async () => {
  T = await makeTenant('pay');
  maker = T.adminUserId;
  checker = await makeUser('checker');
  await pools.system.query(`UPDATE tenants SET payroll_activated_at = now() WHERE id=$1`, [T.tenantId]);
  groupId = await asApp(async (c) => (await c.query<{ id: string }>(
    `INSERT INTO pay_groups (tenant_id, code, name) VALUES ($1,'MONTHLY','Monthly') RETURNING id`, [T.tenantId])).rows[0]!.id);
  emp = await makeEmployee(T);
});
afterAll(closePools);

describe('activation', () => {
  it('runtime role cannot activate payroll or alter control flags', async () => {
    expect(await sqlstate(() => asApp((c) => c.query(`UPDATE tenants SET payroll_activated_at=now() WHERE id=$1`, [T.tenantId])))).toBe('42501');
    expect(await sqlstate(() => asApp((c) => c.query(`UPDATE tenants SET payroll_maker_checker_required=false WHERE id=$1`, [T.tenantId])))).toBe('42501');
  });
  it('a run cannot be created for a tenant that has not activated payroll', async () => {
    const other = await makeTenant('inactive');
    const code = await sqlstate(() => withContext(pools.app, { tenantId: other.tenantId, userId: other.adminUserId }, async (c) => {
      const g = await c.query<{ id: string }>(`INSERT INTO pay_groups (tenant_id, code, name) VALUES ($1,'M','M') RETURNING id`, [other.tenantId]);
      const p = await c.query<{ id: string }>(`INSERT INTO payroll_periods (tenant_id, pay_group_id, period_code, period_start, period_end) VALUES ($1,$2,'2030-01','2030-01-01','2030-01-31') RETURNING id`, [other.tenantId, g.rows[0]!.id]);
      await c.query(`INSERT INTO payroll_runs (tenant_id, payroll_period_id) VALUES ($1,$2)`, [other.tenantId, p.rows[0]!.id]);
    }));
    expect(code).toBe('HT003');
  });
});

describe('state machine', () => {
  it('rejects skipping states', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const run = await newRun(c, await newPeriod(c));
      await setStatus(c, run, 'approved', `, approved_by='${checker}'`);
    }));
    expect(code).toBe('HT003');
  });
  it('requires engine version, input hash and rule bundle hash to be calculated', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const run = await newRun(c, await newPeriod(c));
      await setStatus(c, run, 'validated');
      await setStatus(c, run, 'calculated');
    }));
    expect(code).toBe('HT003');
  });
  it('allows only one in-flight run per period', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const p = await newPeriod(c);
      await newRun(c, p);
      await c.query(`INSERT INTO payroll_runs (tenant_id, payroll_period_id, revision) VALUES ($1,$2,2)`, [T.tenantId, p]);
    }));
    expect(['23505', 'HT003']).toContain(code);
  });
  it('blocking validation exceptions stop validation', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const run = await newRun(c, await newPeriod(c));
      await c.query(`INSERT INTO payroll_exceptions (tenant_id, payroll_run_id, stage, severity, code, message) VALUES ($1,$2,'validation','blocking','NO_BANK','missing bank')`, [T.tenantId, run]);
      await setStatus(c, run, 'validated');
    }));
    expect(code).toBe('HT003');
  });
  it('draft runs can be deleted, advanced ones cannot', async () => {
    await asApp(async (c) => { const run = await newRun(c, await newPeriod(c)); await c.query('DELETE FROM payroll_runs WHERE id=$1', [run]); });
    const code = await sqlstate(() => asApp(async (c) => {
      const run = await newRun(c, await newPeriod(c));
      await setStatus(c, run, 'validated');
      await c.query('DELETE FROM payroll_runs WHERE id=$1', [run]);
    }));
    expect(code).toBe('HT002');
  });
});

describe('maker-checker', () => {
  it('the creator cannot approve', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const run = await calculatedRun(c, emp);
      await setStatus(c, run, 'under_review', `, submitted_by='${checker}'`);
      await setStatus(c, run, 'approved', `, approved_by='${maker}'`);
    }));
    expect(code).toBe('HT004');
  });
  it('the submitter cannot approve', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const run = await calculatedRun(c, emp);
      await setStatus(c, run, 'under_review', `, submitted_by='${checker}'`);
      await setStatus(c, run, 'approved', `, approved_by='${checker}'`);
    }));
    expect(code).toBe('HT004');
  });
  it('a different person can approve; locking reconciles and then the run is immutable', async () => {
    const third = await makeUser('third');
    await asApp(async (c) => {
      const run = await calculatedRun(c, emp);
      await setStatus(c, run, 'under_review', `, submitted_by='${maker}'`);
      await setStatus(c, run, 'approved', `, approved_by='${checker}'`);
      await setStatus(c, run, 'locked', `, locked_by='${checker}'`);
      expect((await c.query('SELECT status FROM payroll_runs WHERE id=$1', [run])).rows[0].status).toBe('locked');
      await c.query('SAVEPOINT s');
      const tamper = await sqlstate(() => c.query(`UPDATE payroll_runs SET total_net_pay=1 WHERE id=$1`, [run]));
      expect(tamper).toBe('HT002');
      await c.query('ROLLBACK TO s');
      await c.query('SAVEPOINT s2');
      expect(await sqlstate(() => c.query(`UPDATE payroll_run_items SET gross_earnings=1, net_pay=1-employee_deductions WHERE payroll_run_id=$1`, [run]))).toBe('HT002');
      await c.query('ROLLBACK TO s2');
      await c.query('SAVEPOINT s3');
      expect(await sqlstate(() => c.query(`DELETE FROM payroll_line_items WHERE payroll_run_item_id IN (SELECT id FROM payroll_run_items WHERE payroll_run_id=$1)`, [run]))).toBe('HT002');
      await c.query('ROLLBACK TO s3');
      // payment status may still move on a locked run; status may go to payslips_generated; never back.
      await c.query(`UPDATE payroll_runs SET payment_status='paid' WHERE id=$1`, [run]);
      await c.query('SAVEPOINT s4');
      expect(await sqlstate(() => setStatus(c, run, 'draft'))).toBe('HT003');
      await c.query('ROLLBACK TO s4');
    });
    void third;
  });
  it('maker-checker also binds adjustments (CHECK)', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const comp = await c.query<{ id: string }>(
        `INSERT INTO salary_components (tenant_id, code, label, component_type) VALUES ($1,'BONUS_X','Bonus','earning') RETURNING id`, [T.tenantId]);
      const p = await newPeriod(c);
      await c.query(
        `INSERT INTO payroll_adjustments (tenant_id, employee_id, payroll_period_id, component_id, kind, amount, reason, status, created_by, approved_by)
         VALUES ($1,$2,$3,$4,'earning',100,'x','approved',$5,$5)`, [T.tenantId, emp, p, comp.rows[0]!.id, maker]);
    }));
    expect(code).toBe('23514');
  });
});

describe('reconciliation', () => {
  it('refuses to lock when run totals do not match items', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const run = await calculatedRun(c, emp);
      await c.query(`UPDATE payroll_runs SET total_net_pay=1 WHERE id=$1`, [run]);
      await setStatus(c, run, 'under_review', `, submitted_by='${maker}'`);
      await setStatus(c, run, 'approved', `, approved_by='${checker}'`);
      await setStatus(c, run, 'locked', `, locked_by='${checker}'`);
    }));
    expect(code).toBe('HT003');
  });
  it('database enforces net = gross - deductions on items', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      const run = await newRun(c, await newPeriod(c));
      await c.query(`INSERT INTO payroll_run_items (tenant_id, payroll_run_id, employee_id, input_snapshot, gross_earnings, employee_deductions, net_pay) VALUES ($1,$2,$3,'{}',100,10,91)`, [T.tenantId, run, emp]);
    }));
    expect(code).toBe('23514');
  });
  it('money columns are exact numerics, never floating point', async () => {
    const { rows } = await pools.admin.query(`
      SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS t
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
       WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND NOT a.attisdropped AND a.attnum>0
         AND (a.atttypid IN ('float4'::regtype,'float8'::regtype) OR format_type(a.atttypid,a.atttypmod)='money')`);
    expect(rows).toEqual([]);
  });
});

describe('controlled correction', () => {
  it('a correction requires a finalised predecessor of the same period', async () => {
    const bad = await sqlstate(() => asApp(async (c) => {
      const p = await newPeriod(c);
      const run = await newRun(c, p);
      await c.query(
        `INSERT INTO payroll_runs (tenant_id, payroll_period_id, revision, run_kind, correction_of_run_id, correction_reason)
         VALUES ($1,$2,2,'correction',$3,'fix')`, [T.tenantId, p, run]);
    }));
    expect(['HT003', '23505']).toContain(bad);
  });
  it('a locked run accepts a correction revision with a reason', async () => {
    await asApp(async (c) => {
      const run = await calculatedRun(c, emp);
      await setStatus(c, run, 'under_review', `, submitted_by='${maker}'`);
      await setStatus(c, run, 'approved', `, approved_by='${checker}'`);
      await setStatus(c, run, 'locked', `, locked_by='${checker}'`);
      const p = (await c.query('SELECT payroll_period_id FROM payroll_runs WHERE id=$1', [run])).rows[0].payroll_period_id;
      const r = await c.query(
        `INSERT INTO payroll_runs (tenant_id, payroll_period_id, revision, run_kind, correction_of_run_id, correction_reason)
         VALUES ($1,$2,2,'correction',$3,'wrong LOP days') RETURNING status`, [T.tenantId, p, run]);
      expect(r.rows[0].status).toBe('draft');
    });
  });
});

describe('attendance lock', () => {
  it('attendance inside a locked payroll period cannot change', async () => {
    const code = await sqlstate(() => asApp(async (c) => {
      await c.query(`UPDATE employees SET pay_group_id=$1, payroll_eligible=true WHERE id=$2`, [groupId, emp]);
      const p = await c.query<{ id: string }>(
        `INSERT INTO payroll_periods (tenant_id, pay_group_id, period_code, period_start, period_end, attendance_locked_at)
         VALUES ($1,$2,'2031-01','2031-01-01','2031-01-31', now()) RETURNING id`, [T.tenantId, groupId]);
      void p;
      await c.query(`INSERT INTO attendance_days (tenant_id, employee_id, work_date, attendance_status) VALUES ($1,$2,'2031-01-10','present')`, [T.tenantId, emp]);
    }));
    expect(code).toBe('HT006');
  });
});

describe('audit trail', () => {
  it('records payroll run changes via DB trigger and the log is append-only even for the owner', async () => {
    const rows = await asApp(async (c) => (await c.query(`SELECT action FROM audit_logs WHERE entity_type='payroll_runs' LIMIT 5`)).rows);
    expect(rows.length).toBeGreaterThan(0);
    const owner = await sqlstate(() => withContext(pools.owner, { tenantId: T.tenantId }, (c) => c.query(`DELETE FROM audit_logs`)));
    expect(owner).toBe('HT001');
    const upd = await sqlstate(() => withContext(pools.owner, { tenantId: T.tenantId }, (c) => c.query(`UPDATE audit_logs SET action='x'`)));
    expect(upd).toBe('HT001');
    const trunc = await sqlstate(() => pools.owner.query(`TRUNCATE audit_logs`));
    expect(['HT001', '42501']).toContain(trunc);
  });
});
