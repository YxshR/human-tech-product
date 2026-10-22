import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, seedPermissions, seedSystemRoles, withContext } from '@humantech/database';
import { Harness, startHarness } from './harness';

export interface World {
  h: Harness; owner: Pool; app: Pool; system: Pool; admin: Pool;
  users: Record<string, string>;
  H: (token: string, tenantId?: string) => Record<string, string>;
  tenant: (slug: string, rootSub: string) => Promise<Tenant>;
  member: (t: Tenant, bySub: string, sub: string, roles: string[], branches?: string[]) => Promise<string>;
  grantRole: (t: Tenant, bySub: string, toSub: string, role: string) => Promise<void>;
  /** Creates an employee record linked to the login `sub` (user is created if needed). */
  employee: (t: Tenant, bySub: string, sub: string | null, o?: { branch?: string; manager?: string; status?: string; joined?: string; name?: string }) => Promise<string>;
  as: (sub: string, t: Tenant, opts?: { mfa?: boolean }) => Promise<Record<string, string>>;
  close: () => Promise<void>;
}
export interface Tenant { id: string; branch: string; branch2: string; rootSub: string }

/**
 * Builds an isolated world: DB pools, HTTP harness and helpers. Tenants get a root user who is
 * the provisioning admin (no roles yet); `bootstrapAdmin` gives a second user company_admin so the
 * no-self-grant rule is respected exactly as in production.
 */
export async function createWorld(): Promise<World> {
  const owner = createPool(process.env.TEST_OWNER_URL!, 3);
  const app = createPool(process.env.TEST_APP_URL!, 5);
  const system = createPool(process.env.TEST_SYSTEM_URL!, 2);
  const admin = createPool(process.env.TEST_ADMIN_URL!, 2);
  await seedPermissions(owner);
  const h = await startHarness();
  const users: Record<string, string> = {};
  const userFor = async (sub: string): Promise<string> => {
    if (users[sub]) return users[sub]!;
    users[sub] = (await app.query('SELECT app.upsert_user_from_identity($1,$2,$3,true) AS id', [sub, `${sub}@example.test`, sub])).rows[0].id;
    return users[sub]!;
  };
  const w: World = {
    h, owner, app, system, admin, users,
    H: (token, tenantId) => ({ Authorization: `Bearer ${token}`, ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}) }),
    tenant: async (slug, rootSub) => {
      const root = await userFor(rootSub);
      const id = (await system.query('SELECT app.provision_tenant($1,$2,$2,$3) AS id', [`${slug}-${randomUUID().slice(0, 6)}`, slug, root])).rows[0].id as string;
      await seedSystemRoles(owner, id);
      const [b1, b2] = await withContext(app, { tenantId: id, userId: root }, async (c) => [
        (await c.query(`INSERT INTO branches (tenant_id, code, name) VALUES ($1,'B1','Branch 1') RETURNING id`, [id])).rows[0].id as string,
        (await c.query(`INSERT INTO branches (tenant_id, code, name) VALUES ($1,'B2','Branch 2') RETURNING id`, [id])).rows[0].id as string,
      ]);
      // A second user bootstraps the root user as company admin (no self-grant).
      const boot = `${rootSub}-boot`;
      const bootId = await userFor(boot);
      await withContext(app, { tenantId: id, userId: root }, async (c) => {
        await c.query(`INSERT INTO tenant_memberships (tenant_id,user_id,status,branch_scope_mode) VALUES ($1,$2,'active','all')`, [id, bootId]);
        await c.query(`INSERT INTO membership_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND role_key='company_admin'`, [id, bootId]);
      });
      await withContext(app, { tenantId: id, userId: bootId }, (c) =>
        c.query(`INSERT INTO membership_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND role_key='company_admin'`, [id, root]));
      return { id, branch: b1!, branch2: b2!, rootSub };
    },
    member: async (t, bySub, sub, roles, branches) => {
      const uid = await userFor(sub);
      const by = await userFor(bySub);
      await withContext(app, { tenantId: t.id, userId: by }, async (c) => {
        await c.query(`INSERT INTO tenant_memberships (tenant_id,user_id,status,branch_scope_mode) VALUES ($1,$2,'active',$3)`, [t.id, uid, branches ? 'listed' : 'all']);
        for (const b of branches ?? []) await c.query(`INSERT INTO membership_branch_scopes (tenant_id,user_id,branch_id) VALUES ($1,$2,$3)`, [t.id, uid, b]);
        for (const r of roles) await c.query(`INSERT INTO membership_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND role_key=$3`, [t.id, uid, r]);
      });
      return uid;
    },
    grantRole: async (t, bySub, toSub, role) => {
      await withContext(app, { tenantId: t.id, userId: users[bySub] }, (c) =>
        c.query(`INSERT INTO membership_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND role_key=$3`, [t.id, users[toSub], role]));
    },
    employee: async (t, bySub, sub, o = {}) => {
      const uid = sub ? await userFor(sub) : null;
      const by = await userFor(bySub);
      return withContext(app, { tenantId: t.id, userId: by }, async (c) => {
        const n = (await c.query('SELECT app.next_employee_number() AS n')).rows[0].n as string;
        return (await c.query(
          `INSERT INTO employees (tenant_id, employee_number, first_name, branch_id, manager_id, user_id, employment_status, joined_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [t.id, n, o.name ?? sub ?? 'Emp', o.branch ?? t.branch, o.manager ?? null, uid, o.status ?? 'active', o.joined ?? '2020-01-01'])).rows[0].id as string;
      });
    },
    as: async (sub, t, o) => w.H(await h.token(sub, { mfa: o?.mfa }), t.id),
    close: async () => { await h.close(); await Promise.all([owner.end(), app.end(), system.end(), admin.end()]); },
  };
  return w;
}
