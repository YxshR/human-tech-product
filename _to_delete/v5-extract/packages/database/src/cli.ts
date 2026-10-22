import { Pool } from 'pg';
import { bootstrapRoles } from './bootstrap';
import { migrate } from './migrate';
import { seedPermissions } from './seed';
import { activatePayroll, approveRule, createCompany, importRules, listPayrollRequests, listRules, syncRoles } from './platform-cli';

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
  } else if (cmd === 'create-company' || cmd === 'sync-roles') {
    const args = process.argv.slice(3);
    const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
    const slug = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
    const owner = new Pool({ connectionString: need('DATABASE_OWNER_URL'), max: 1 });
    try {
      if (cmd === 'sync-roles') {
        console.log(`system roles synced for ${await syncRoles(owner, slug)} company(ies)`);
      } else {
        const adminEmail = flag('admin-email');
        const name = flag('name');
        if (!slug || !adminEmail || !name) throw new Error('usage: create-company <slug> --name "Legal name" --admin-email <email> [--display "Short name"] [--operator <email>] [--print-link]');
        const system = new Pool({ connectionString: need('DATABASE_SYSTEM_URL'), max: 1 });
        try {
          const r = await createCompany(owner, system, { slug, legalName: name, displayName: flag('display'), adminEmail, operatorEmail: flag('operator') ?? need('OPERATOR_EMAIL') });
          console.log(`created ${r.slug} (${r.tenantId}); invitation for ${adminEmail} expires ${r.expiresAt}. The worker e-mails the link.`);
          if (args.includes('--print-link')) console.log(`${(process.env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(r.inviteToken)}`);
        } finally {
          await system.end();
        }
      }
    } finally {
      await owner.end();
    }
  } else if (['payroll-requests', 'activate-payroll', 'import-rules', 'list-rules', 'approve-rule'].includes(cmd ?? '')) {
    const pool = new Pool({ connectionString: need('DATABASE_SYSTEM_URL'), max: 1 });
    const args = process.argv.slice(3);
    const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
    const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--') && args[i - 1] !== '--force'));
    const operator = () => flag('operator') ?? need('OPERATOR_EMAIL');
    try {
      if (cmd === 'payroll-requests') {
        const rows = await listPayrollRequests(pool);
        console.log(rows.length ? rows.map((r) => `${r.slug}\t${r.displayName}\trequested ${r.requestedAt}`).join('\n') : 'no pending requests');
      } else if (cmd === 'activate-payroll') {
        if (!positional[0]) throw new Error('usage: activate-payroll <company-slug> --operator <email> [--force]');
        const r = await activatePayroll(pool, positional[0], operator(), { allowWithoutRequest: args.includes('--force') });
        console.log(`payroll activated for ${r.slug} at ${r.activatedAt}`);
      } else if (cmd === 'import-rules') {
        if (!positional[0]) throw new Error('usage: import-rules <rules.json> --operator <email>');
        const r = await importRules(pool, positional[0], operator());
        console.log(r.imported.map((x) => `${x.id}\t${x.ruleGroup} v${x.version}\tin_review`).join('\n'));
      } else if (cmd === 'list-rules') {
        const rows = await listRules(pool, flag('status'));
        console.log(rows.length ? rows.map((r) => `${r.id}\t${r.ruleGroup}${r.stateCode ? `/${r.stateCode}` : ''} v${r.version}\tfrom ${r.effectiveFrom}\t${r.status}`).join('\n') : 'no rules');
      } else {
        if (!positional[0]) throw new Error('usage: approve-rule <rule-id> --operator <reviewer-email> [--notes "..."]');
        await approveRule(pool, positional[0], operator(), flag('notes'));
        console.log('approved');
      }
    } finally {
      await pool.end();
    }
  } else {
    console.error('usage: cli.ts <bootstrap|migrate|seed|create-company|sync-roles|payroll-requests|activate-payroll|import-rules|list-rules|approve-rule>');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
