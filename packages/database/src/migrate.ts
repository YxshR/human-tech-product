import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

export interface MigrationFile {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(dir, filename), 'utf8');
      return {
        version: filename.slice(0, 4),
        filename,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const LOCK_KEY = 7_201_026; // arbitrary constant: serialises concurrent migrators

/**
 * Applies pending migrations in order, each in its own transaction.
 * - Already-applied migrations are verified by checksum: editing history is refused.
 * - A session advisory lock prevents two deploys from migrating at once.
 * Run with the OWNER role (DATABASE_OWNER_URL), never the runtime role.
 */
export async function migrate(ownerUrl: string, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        filename text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations',
      )).rows.map((r) => [r.version, r.checksum]),
    );

    for (const m of loadMigrations(dir)) {
      const existing = done.get(m.version);
      if (existing) {
        if (existing !== m.checksum) {
          throw new Error(
            `Migration ${m.filename} was modified after being applied (checksum mismatch). ` +
              'Never edit an applied migration; add a new forward migration instead.',
          );
        }
        result.skipped.push(m.version);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
          [m.version, m.filename, m.checksum],
        );
        await client.query('COMMIT');
        result.applied.push(m.version);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${m.filename} failed: ${(err as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
