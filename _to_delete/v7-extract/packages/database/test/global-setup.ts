import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { bootstrapRoles, migrate, withCredentials, withDatabase } from '../src';

/**
 * Creates a throw-away database per test run, bootstraps roles, applies ALL migrations
 * with the owner role, and exposes connection strings to the tests via env.
 * Requires TEST_DATABASE_ADMIN_URL (a superuser), e.g. postgresql://postgres:postgres@localhost:5432/postgres
 */
export default async function setup(): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
  const dbName = `ht_test_${randomBytes(4).toString('hex')}`;
  const pw = { ownerPassword: 'owner_pw', appPassword: 'app_pw', systemPassword: 'system_pw' };
  await bootstrapRoles({ adminUrl, database: dbName, ...pw });
  const base = withDatabase(adminUrl, dbName);
  const ownerUrl = withCredentials(base, 'humantech_owner', pw.ownerPassword);
  await migrate(ownerUrl);
  process.env.TEST_ADMIN_URL = base;
  process.env.TEST_OWNER_URL = ownerUrl;
  process.env.TEST_APP_URL = withCredentials(base, 'humantech_app', pw.appPassword);
  process.env.TEST_SYSTEM_URL = withCredentials(base, 'humantech_system', pw.systemPassword);
  return async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  };
}
