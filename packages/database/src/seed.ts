import { Pool, PoolClient } from 'pg';
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  ROLES,
  ROLE_KEYS,
  permissionDomain,
  sensitivityOf,
} from '@humantech/authz';
import { withContext } from './context';

/** Upserts the global permission catalogue (owner connection). Idempotent. */
export async function seedPermissions(client: PoolClient | Pool): Promise<number> {
  for (const key of PERMISSION_KEYS) {
    await client.query(
      `INSERT INTO permissions (permission_key, domain, description, sensitivity)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (permission_key) DO UPDATE
         SET domain = EXCLUDED.domain, description = EXCLUDED.description, sensitivity = EXCLUDED.sensitivity`,
      [key, permissionDomain(key), PERMISSIONS[key].description, sensitivityOf(key)],
    );
  }
  return PERMISSION_KEYS.length;
}

/** Creates the system roles and their grants for one tenant (owner connection). Idempotent. */
export async function seedSystemRoles(pool: Pool, tenantId: string): Promise<void> {
  await withContext(pool, { tenantId }, (c) => seedSystemRolesIn(c, tenantId));
}

/** Same, inside a transaction the caller already opened with the tenant context set. */
export async function seedSystemRolesIn(c: PoolClient, tenantId: string): Promise<void> {
  for (const roleKey of ROLE_KEYS) {
    const def = ROLES[roleKey];
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO roles (tenant_id, role_key, name, is_system_role)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (tenant_id, role_key) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [tenantId, roleKey, def.name],
    );
    const roleId = rows[0]!.id;
    await c.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_key)
         SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`,
      [tenantId, roleId, [...def.permissions]],
    );
    // Remove grants that left the system role definition (system roles follow the code).
    await c.query(
      `DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2 AND permission_key <> ALL($3::text[])`,
      [tenantId, roleId, [...def.permissions]],
    );
  }
}
