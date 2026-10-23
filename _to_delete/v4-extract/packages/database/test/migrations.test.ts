import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { bootstrapRoles, loadMigrations, migrate, withCredentials, withDatabase } from '../src';

const MIGRATIONS = join(__dirname, '..', 'migrations');
const adminBase = process.env.TEST_ADMIN_URL!;
const created: string[] = [];

async function freshDb(): Promise<string> {
  const name = `ht_mig_${randomBytes(4).toString('hex')}`;
  await bootstrapRoles({ adminUrl: adminBase, database: name, ownerPassword: 'owner_pw', appPassword: 'app_pw', systemPassword: 'system_pw' });
  created.push(name);
  return withCredentials(withDatabase(adminBase, name), 'humantech_owner', 'owner_pw');
}

afterAll(async () => {
  const admin = new Client({ connectionString: adminBase });
  await admin.connect();
  for (const n of created) await admin.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
  await admin.end();
});

describe('migrator', () => {
  it('migrations are contiguous, uniquely numbered and checksummed', () => {
    const ms = loadMigrations(MIGRATIONS);
    expect(ms.length).toBeGreaterThanOrEqual(7);
    ms.forEach((m, i) => expect(m.version).toBe(String(i + 1).padStart(4, '0')));
    expect(new Set(ms.map((m) => m.checksum)).size).toBe(ms.length);
  });

  it('applies everything once and is a no-op the second time', async () => {
    const url = await freshDb();
    const first = await migrate(url);
    expect(first.applied.length).toBe(loadMigrations(MIGRATIONS).length);
    const second = await migrate(url);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const url = await freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync(MIGRATIONS, dir, { recursive: true });
    await migrate(url, dir);
    const file = join(dir, readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()[0]!);
    writeFileSync(file, readFileSync(file, 'utf8') + '\n-- tampered\n');
    await expect(migrate(url, dir)).rejects.toThrow(/modified after being applied/);
  });

  it('rolls a failing migration back completely and leaves earlier ones applied', async () => {
    const url = await freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync(MIGRATIONS, dir, { recursive: true });
    writeFileSync(join(dir, '9999_broken.sql'), 'CREATE TABLE half_done (id int); SELECT 1/0;');
    await expect(migrate(url, dir)).rejects.toThrow(/9999_broken\.sql failed/);
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      expect((await c.query(`SELECT to_regclass('public.half_done') AS t`)).rows[0].t).toBeNull();
      expect((await c.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(loadMigrations(MIGRATIONS).length);
    } finally {
      await c.end();
    }
  });

  it('two concurrent migrators do not collide', async () => {
    const url = await freshDb();
    const [a, b] = await Promise.all([migrate(url), migrate(url)]);
    const total = loadMigrations(MIGRATIONS).length;
    expect(a.applied.length + b.applied.length).toBe(total);
  });

  it('bootstrap is idempotent', async () => {
    const name = `ht_mig_${randomBytes(4).toString('hex')}`;
    const opts = { adminUrl: adminBase, database: name, ownerPassword: 'owner_pw', appPassword: 'app_pw', systemPassword: 'system_pw' };
    await bootstrapRoles(opts);
    created.push(name);
    await expect(bootstrapRoles(opts)).resolves.toBeUndefined();
  });
});
