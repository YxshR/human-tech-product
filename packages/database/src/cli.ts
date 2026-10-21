import { Pool } from 'pg';
import { bootstrapRoles } from './bootstrap';
import { migrate } from './migrate';
import { seedPermissions } from './seed';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'bootstrap') {
    await bootstrapRoles({
      adminUrl: need('DATABASE_ADMIN_URL'),
      database: need('DATABASE_NAME'),
      ownerPassword: need('DB_OWNER_PASSWORD'),
      appPassword: need('DB_APP_PASSWORD'),
      systemPassword: need('DB_SYSTEM_PASSWORD'),
    });
    console.log('roles bootstrapped');
  } else if (cmd === 'migrate') {
    const { applied } = await migrate(need("DATABASE_OWNER_URL"));
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  } else if (cmd === 'seed') {
    const pool = new Pool({ connectionString: need('DATABASE_OWNER_URL'), max: 1 });
    try {
      console.log(`seeded ${await seedPermissions(pool)} permissions`);
    } finally {
      await pool.end();
    }
  } else {
    console.error('usage: cli.ts <bootstrap|migrate|seed>');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
