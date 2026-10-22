import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, seedPermissions, seedSystemRoles, withContext } from '../src';

export const pools = {
  owner: createPool(process.env.TEST_OWNER_URL!, 5),
  app: createPool(process.env.TEST_APP_URL!, 10),
  system: createPool(process.env.TEST_SYSTEM_URL!, 3),
  admin: createPool(process.env.TEST_ADMIN_URL!, 3),
};

export async function closePools(): Promise<void> {
  await Promise.all(Object.values(pools).map((p) => p.end()));
}

let seeded = false;
export async function ensureCatalogue(): Promise<void> {
  if (seeded) return;
  await seedPermissions(pools.owner);
  seeded = true;
}

export interface TestTenant {
  tenantId: string;
  adminUserId: string;
  branchId: string;
  slug: string;
}

export async function makeUser(label: string): Promise<string> {
  const sub = `${label}-${randomUUID()}`;
  const { rows } = await pools.app.query<{ id: string }>(
    'SELECT app.upsert_user_from_identity($1,$2,$3,true) AS id',
    [sub, `${sub}@example.test`, label],
  );
  return rows[0]!.id;
}

export async function makeTenant(label = 't'): Promise<TestTenant> {
  await ensureCatalogue();
  const adminUserId = await makeUser(`${label}-admin`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const { rows } = await pools.system.query<{ id: string }>(
    'SELECT app.provision_tenant($1,$2,$3,$4) AS id',
    [slug, `${label} Pvt Ltd`, label, adminUserId],
  );
  const tenantId = rows[0]!.id;
  await seedSystemRoles(pools.owner, tenantId);
  const branchId = await withContext(pools.app, { tenantId, userId: adminUserId }, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO branches (tenant_id, code, name) VALUES ($1,'HQ','Head Office') RETURNING id`,
      [tenantId],
    );
    return r.rows[0]!.id;
  });
  return { tenantId, adminUserId, branchId, slug };
}

/** Insert a plain employee (no login) as the tenant's runtime role. */
export async function makeEmployee(
  t: TestTenant,
  over: { first?: string; managerId?: string; joined?: string; payroll?: boolean } = {},
): Promise<string> {
  return withContext(pools.app, { tenantId: t.tenantId, userId: t.adminUserId }, async (c) => {
    const n = await c.query<{ n: string }>(`SELECT app.next_employee_number() AS n`);
    const r = await c.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, branch_id, manager_id, joined_at, payroll_eligible, employment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id`,
      [t.tenantId, n.rows[0]!.n, over.first ?? 'Asha', t.branchId, over.managerId ?? null, over.joined ?? '2025-04-01', over.payroll ?? false],
    );
    return r.rows[0]!.id;
  });
}

/** Run a statement expecting a Postgres error; returns its SQLSTATE (or throws if it succeeds). */
export async function sqlstate(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code) return code;
    throw e;
  }
  throw new Error('expected statement to fail but it succeeded');
}

export type { Pool };
