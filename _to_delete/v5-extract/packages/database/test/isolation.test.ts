import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext } from '../src';
import { closePools, makeEmployee, makeTenant, pools, sqlstate, TestTenant } from './helpers';

let A: TestTenant;
let B: TestTenant;
let empA: string;
let empB: string;

beforeAll(async () => {
  A = await makeTenant('a');
  B = await makeTenant('b');
  empA = await makeEmployee(A, { first: 'Alice' });
  empB = await makeEmployee(B, { first: 'Bob' });
});
afterAll(closePools);

describe('runtime role posture', () => {
  it('is not superuser, not bypassrls, owns nothing', async () => {
    const { rows } = await pools.app.query(
      `SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
              (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid AND c.relnamespace = 'public'::regnamespace) AS owned
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    expect(Number(rows[0].owned)).toBe(0);
  });
  it('system and owner roles also lack superuser/bypassrls', async () => {
    const { rows } = await pools.admin.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'humantech_%'`,
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });
});

describe('row level security', () => {
  it('no tenant context => zero rows', async () => {
    const { rows } = await pools.app.query('SELECT id FROM employees');
    expect(rows).toHaveLength(0);
  });
  it('sees only own tenant rows', async () => {
    const rows = await withContext(pools.app, { tenantId: A.tenantId }, async (c) => (await c.query('SELECT id FROM employees')).rows);
    expect(rows.map((r) => r.id)).toEqual([empA]);
  });
  it("cannot read another tenant's row by id", async () => {
    const rows = await withContext(pools.app, { tenantId: A.tenantId }, async (c) =>
      (await c.query('SELECT id FROM employees WHERE id = $1', [empB])).rows);
    expect(rows).toHaveLength(0);
  });
  it('cannot update or delete another tenant\'s rows (0 rows affected)', async () => {
    await withContext(pools.app, { tenantId: A.tenantId }, async (c) => {
      const u = await c.query(`UPDATE employees SET first_name='Hacked' WHERE id=$1`, [empB]);
      const d = await c.query(`DELETE FROM employees WHERE id=$1`, [empB]);
      expect(u.rowCount).toBe(0);
      expect(d.rowCount).toBe(0);
    });
    const r = await withContext(pools.app, { tenantId: B.tenantId }, async (c) => (await c.query('SELECT first_name FROM employees')).rows);
    expect(r[0].first_name).toBe('Bob');
  });
  it('WITH CHECK blocks inserting a row for a different tenant', async () => {
    const code = await sqlstate(() =>
      withContext(pools.app, { tenantId: A.tenantId }, (c) =>
        c.query(`INSERT INTO branches (tenant_id, code, name) VALUES ($1,'X','Evil')`, [B.tenantId])));
    expect(code).toBe('42501');
  });
  it('WITH CHECK blocks moving a row to another tenant', async () => {
    const code = await sqlstate(() =>
      withContext(pools.app, { tenantId: A.tenantId }, (c) =>
        c.query(`UPDATE employees SET tenant_id=$1 WHERE id=$2`, [B.tenantId, empA])));
    expect(['42501', '23503']).toContain(code);
  });
  it('context does not leak between pooled transactions', async () => {
    const small = (await import('../src')).createPool(process.env.TEST_APP_URL!, 1);
    try {
      await withContext(small, { tenantId: A.tenantId }, (c) => c.query('SELECT 1'));
      const { rows } = await small.query(`SELECT current_setting('app.tenant_id', true) AS t`);
      expect(rows[0].t === '' || rows[0].t === null).toBe(true);
      expect((await small.query('SELECT id FROM employees')).rows).toHaveLength(0);
    } finally {
      await small.end();
    }
  });
  it('rejects non-uuid tenant ids before touching the database', async () => {
    await expect(withContext(pools.app, { tenantId: "x' OR '1'='1" }, async () => 1)).rejects.toThrow('invalid tenant id');
  });
});

describe('composite tenant foreign keys', () => {
  it('an employee in tenant A cannot reference a branch of tenant B', async () => {
    const code = await sqlstate(() =>
      withContext(pools.app, { tenantId: A.tenantId, userId: A.adminUserId }, (c) =>
        c.query(`UPDATE employees SET branch_id=$1 WHERE id=$2`, [B.branchId, empA])));
    expect(code).toBe('23503');
  });
  it('an employee cannot report to a manager of another tenant', async () => {
    const code = await sqlstate(() =>
      withContext(pools.app, { tenantId: A.tenantId, userId: A.adminUserId }, (c) =>
        c.query(`UPDATE employees SET manager_id=$1 WHERE id=$2`, [empB, empA])));
    expect(code).toBe('23503');
  });
});

describe('schema lint', () => {
  it('every table with tenant_id has RLS enabled, forced and a policy', async () => {
    const { rows } = await pools.admin.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
       WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace`);
    expect(rows.length).toBeGreaterThan(50);
    const bad = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || Number(r.policies) < 1).map((r) => r.relname);
    // 'tenants' itself has no tenant_id column; tables listed here are intentional global-or-identity exceptions.
    expect(bad).toEqual([]);
  });
  it('tables without tenant_id are an explicit allowlist', async () => {
    const { rows } = await pools.admin.query(`
      SELECT c.relname FROM pg_class c
       WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace
         AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
       ORDER BY 1`);
    const names = rows.map((r) => r.relname as string);
    const allowed = new Set([
      'tenants', 'users', 'user_sessions', 'platform_staff', 'permissions', 'schema_migrations',
      'statutory_rule_sets', 'plans',
    ]);
    const unexpected = names.filter((n) => !allowed.has(n));
    expect(unexpected).toEqual([]);
  });
  it('every foreign key from a tenant table to another tenant table is composite', async () => {
    const { rows } = await pools.admin.query(`
      SELECT con.conname, c.relname AS child, p.relname AS parent, array_length(con.conkey,1) AS cols
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_class p ON p.oid = con.confrelid
       WHERE con.contype='f' AND c.relnamespace='public'::regnamespace
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=p.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
         AND p.relname <> 'tenants' AND array_length(con.conkey,1) = 1`);
    expect(rows.map((r) => `${r.child}.${r.conname}->${r.parent}`)).toEqual([]);
  });
  it('runtime role cannot touch migration bookkeeping or alter schema', async () => {
    expect(await sqlstate(() => pools.app.query(`CREATE TABLE evil (id int)`))).toBe('42501');
    expect(await sqlstate(() => pools.app.query(`DELETE FROM schema_migrations`))).toBe('42501');
  });
});
