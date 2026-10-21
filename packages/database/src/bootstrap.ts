import { Client } from 'pg';

export interface BootstrapOptions {
  adminUrl: string; // superuser / CREATEROLE connection
  database: string;
  ownerPassword: string;
  appPassword: string;
  systemPassword: string;
}

const ROLES = [
  { name: 'humantech_owner', pw: 'ownerPassword' },
  { name: 'humantech_app', pw: 'appPassword' },
  { name: 'humantech_system', pw: 'systemPassword' },
] as const;

function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return `"${s}"`;
}

/**
 * Idempotent. Creates the three least-privilege roles and the database.
 * None of the roles is SUPERUSER or BYPASSRLS - that is a hard requirement (ADR-0005).
 */
export async function bootstrapRoles(opts: BootstrapOptions): Promise<void> {
  const admin = new Client({ connectionString: opts.adminUrl });
  await admin.connect();
  try {
    for (const role of ROLES) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role.name]);
      const pw = opts[role.pw].replace(/'/g, "''");
      const attrs = `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${pw}'`;
      await admin.query(
        exists.rowCount ? `ALTER ROLE ${ident(role.name)} ${attrs}` : `CREATE ROLE ${ident(role.name)} ${attrs}`,
      );
    }
    const db = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [opts.database]);
    if (!db.rowCount) {
      await admin.query(`CREATE DATABASE ${ident(opts.database)} OWNER humantech_owner`);
    }
    // A database created beforehand (managed Postgres, manual setup) must still end up owned by the owner role.
    await admin.query(`ALTER DATABASE ${ident(opts.database)} OWNER TO humantech_owner`);
    await admin.query(`REVOKE ALL ON DATABASE ${ident(opts.database)} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${ident(opts.database)} TO humantech_app, humantech_system`,
    );
  } finally {
    await admin.end();
  }
  // The public schema must be owned by the owner role so migrations can create objects.
  const dbClient = new Client({ connectionString: withDatabase(opts.adminUrl, opts.database) });
  await dbClient.connect();
  try {
    await dbClient.query('ALTER SCHEMA public OWNER TO humantech_owner');
  } finally {
    await dbClient.end();
  }
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}
