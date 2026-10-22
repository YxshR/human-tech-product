#!/usr/bin/env node
/**
 * DEVELOPER-ONLY: creates a demo company with one account per role, so you can sign in and click around.
 * Needs: database migrated, API running (:4000), `pnpm dev:idp` running, and your .env loaded (DATABASE_*, OPERATOR_EMAIL optional).
 *   pnpm dev:demo
 */
import { spawnSync } from 'node:child_process';

if (process.env.NODE_ENV === 'production') { console.error('demo-seed refuses to run in production.'); process.exit(1); }
const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const IDP = `http://127.0.0.1:${process.env.DEV_IDP_PORT ?? 9100}`;
const SLUG = 'demo';
const tok = async (e) => { const r = await fetch(`${IDP}/_token?email=${e}`); if (!r.ok) throw new Error(`dev-idp unreachable or unknown user (${e}). Is "pnpm dev:idp" running?`); return (await r.json()).token; };
const call = async (token, method, path, body, tenant) => {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(tenant ? { 'x-tenant-id': tenant } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j?.error ?? j)}`);
  return j;
};

const owner = await tok('owner@demo.test');
let companies = [];
try { companies = (await call(owner, 'GET', '/me')).data.companies; } catch (e) { throw new Error(`API not reachable at ${API}: ${e.message}`); }
let tenant = companies.find((c) => c.slug === SLUG || /demo/i.test(c.name))?.id;

if (!tenant) {
  const r = spawnSync('node', ['packages/database/dist/cli.js', 'create-company', SLUG, '--name', 'Demo Company Pvt Ltd', '--display', 'Demo Company', '--admin-email', 'owner@demo.test', '--operator', process.env.OPERATOR_EMAIL ?? 'dev@demo.test', '--print-link'], { encoding: 'utf8', env: process.env });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error('create-company failed (build first: pnpm build; and load .env).'); }
  const token = decodeURIComponent((r.stdout.match(/token=([^\s]+)/) ?? [])[1] ?? '');
  await call(owner, 'POST', '/access/invitations/accept', { token });
  tenant = (await call(owner, 'GET', '/me')).data.companies[0].id;
  console.log('created company "Demo Company"');
} else console.log('company already exists, topping up');

const personas = { 'hr@demo.test': ['hr_admin'], 'finance@demo.test': ['finance_payroll'], 'approver@demo.test': ['payroll_approver'], 'recruiter@demo.test': ['recruiter'], 'manager@demo.test': ['department_manager'], 'employee@demo.test': ['employee'] };
for (const [email, roleKeys] of Object.entries(personas)) {
  try {
    const inv = await call(owner, 'POST', '/access/invitations', { email, roleKeys, branchScope: 'all' }, tenant);
    await call(await tok(email), 'POST', '/access/invitations/accept', { token: inv.data.acceptToken });
    console.log('  added', email, roleKeys.join(','));
  } catch (e) { console.log('  skipped', email, '-', String(e.message).slice(0, 90)); }
}

// A branch and a few people, so lists are not empty. The employee login is linked to a real employee record.
let branch = (await call(owner, 'GET', '/branches', undefined, tenant)).data?.[0];
if (!branch) branch = (await call(owner, 'POST', '/branches', { code: 'HQ', name: 'Head office', timezone: 'Asia/Kolkata' }, tenant)).data;
const people = [['Asha', 'Verma', 'employee@demo.test'], ['Ravi', 'Nair', 'ravi@demo.test'], ['Meera', 'Iyer', 'meera@demo.test']];
const existing = (await call(owner, 'GET', '/employees?limit=100', undefined, tenant)).data ?? [];
for (const [firstName, lastName, workEmail] of people) {
  if (existing.some((e) => e.workEmail === workEmail)) continue;
  await call(owner, 'POST', '/employees', { firstName, lastName, workEmail, branchId: branch.id, joinedAt: '2026-04-01' }, tenant);
  console.log('  employee', firstName, lastName);
}
// Link the employee@ login to its employee record (so My profile, leave, attendance and payslips work for that account).
const users = (await call(owner, 'GET', '/access/users', undefined, tenant)).data;
const login = users.find((x) => x.email === 'employee@demo.test');
const emp = ((await call(owner, 'GET', '/employees?limit=100', undefined, tenant)).data ?? []).find((e) => e.workEmail === 'employee@demo.test');
if (login && emp && !login.employeeId) { await call(owner, 'PUT', `/employees/${emp.id}/login`, { userId: login.userId }, tenant); console.log('  linked employee@demo.test to', emp.firstName); }
console.log('\nDone. Open http://localhost:3000 and sign in with any account below (password: ' + (process.env.DEV_IDP_PASSWORD ?? 'Demo@12345') + ')\n  owner@demo.test  hr@demo.test  finance@demo.test  approver@demo.test  recruiter@demo.test  manager@demo.test  employee@demo.test');
