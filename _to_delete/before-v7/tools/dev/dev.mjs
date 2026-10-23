#!/usr/bin/env node
/**
 * DEVELOPER-ONLY: one command that gets a local copy running.  pnpm dev
 *   1. creates/repairs .env (generates the secret keys, points sign-in at the local developer login)
 *   2. waits for Postgres, creates the database roles, migrates and seeds
 *   3. starts the developer login (:9100), API (:4000), worker and web app (:3000)
 *   4. creates "Demo Company" with one account per role (password Demo@12345)
 * Flags: --rebuild (rebuild API/worker first), --no-demo (skip the demo company).   Refuses to run with NODE_ENV=production.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';

if (process.env.NODE_ENV === 'production') { console.error('dev.mjs refuses to run in production.'); process.exit(1); }
const ROOT = new URL('../../', import.meta.url).pathname;
process.chdir(ROOT);
const flags = new Set(process.argv.slice(2));
const log = (m) => console.log(`\x1b[1m▶ ${m}\x1b[0m`);
const die = (m) => { console.error(`\x1b[31m✖ ${m}\x1b[0m`); process.exit(1); };

// ---------- 1. .env ----------
const b64 = () => randomBytes(32).toString('base64');
function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (!m) continue;
    out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
  return out;
}
function ensureEnv() {
  let text = existsSync('.env') ? readFileSync('.env', 'utf8') : readFileSync('.env.example', 'utf8');
  const set = (k, v, force = false) => {
    const re = new RegExp(`^#?\\s*${k}=.*$`, 'm');
    const cur = parseEnv(text)[k];
    if (cur !== undefined && !force) return;
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : text.trimEnd() + `\n${k}=${v}\n`;
  };
  const cur = parseEnv(text);
  if (!cur.FIELD_ENCRYPTION_KEYS || /REPLACE_WITH/.test(cur.FIELD_ENCRYPTION_KEYS)) set('FIELD_ENCRYPTION_KEYS', `1:${b64()}`, true);
  if (!cur.BLIND_INDEX_KEY || /REPLACE_WITH/.test(cur.BLIND_INDEX_KEY)) set('BLIND_INDEX_KEY', b64(), true);
  if (!cur.FILE_SIGNING_SECRET || /replace-with/.test(cur.FILE_SIGNING_SECRET)) set('FILE_SIGNING_SECRET', randomBytes(32).toString('hex'), true);
  set('DATABASE_NAME', 'humantech'); set('DB_OWNER_PASSWORD', 'owner_dev_password'); set('DB_APP_PASSWORD', 'app_dev_password'); set('DB_SYSTEM_PASSWORD', 'system_dev_password');
  set('DATABASE_ADMIN_URL', 'postgresql://postgres:postgres@localhost:5432/postgres'); set('OPERATOR_EMAIL', 'dev@demo.test');
  writeFileSync('.env', text);
  return parseEnv(text);
}
const fileEnv = ensureEnv();
const env = {
  ...fileEnv, ...process.env, NODE_ENV: 'development',
  // Local development always signs in through the developer login server.
  OIDC_ISSUER: 'http://127.0.0.1:9100', OIDC_AUDIENCE: 'humantech-api', OIDC_CLIENT_ID: 'web', APP_URL: 'http://localhost:3000', API_URL: 'http://localhost:4000', WEB_BASE_URL: 'http://localhost:3000', CORS_ORIGINS: 'http://localhost:3000',
};
log('.env is ready (keys generated if they were missing)');

// ---------- 2. Postgres ----------
const pgRequire = createRequire(new URL('../../packages/database/package.json', import.meta.url));
const { Client } = pgRequire('pg');
async function canConnect(url) { const c = new Client({ connectionString: url, connectionTimeoutMillis: 2500 }); try { await c.connect(); await c.end(); return true; } catch { return false; } }
const candidates = [...new Set([env.DATABASE_ADMIN_URL, `postgresql://${os.userInfo().username}@localhost:5432/postgres`, 'postgresql://postgres@localhost:5432/postgres'])];
let adminUrl = null;
for (let i = 0; i < 12 && !adminUrl; i++) {
  for (const u of candidates) if (await canConnect(u)) { adminUrl = u; break; }
  if (!adminUrl) { if (i === 0) console.log('Waiting for Postgres on localhost:5432 …  (start it with:  docker compose up -d postgres   or   brew services start postgresql@16)'); await sleep(2500); }
}
if (!adminUrl) die('Postgres is not reachable on localhost:5432. Start it (docker compose up -d postgres) and run pnpm dev again.');
env.DATABASE_ADMIN_URL = adminUrl;
log('Postgres is up');

// ---------- build ----------
const newest = (dir) => { let m = 0; if (!existsSync(dir)) return m; for (const f of readdirSync(dir, { withFileTypes: true })) { if (f.name === 'node_modules' || f.name === 'dist') continue; const p = `${dir}/${f.name}`; m = Math.max(m, f.isDirectory() ? newest(p) : statSync(p).mtimeMs); } return m; };
const SRC = ['apps/api', 'apps/worker', 'packages/database', 'packages/contracts', 'packages/authz', 'packages/jobs', 'packages/storage', 'packages/payroll-engine'];
const outOfDate = ['apps/api', 'apps/worker', 'packages/database'].some((d) => !existsSync(`${d}/dist`)) || Math.max(...SRC.map(newest)) > statSync('apps/api/dist/main.js').mtimeMs;
if (outOfDate || flags.has('--rebuild')) {
  log('Building API, worker and shared packages (first run takes a minute) …');
  const r = spawnSync('pnpm', ['--filter', '@humantech/api...', '--filter', '@humantech/worker...', '--filter', '@humantech/database...', 'build'], { stdio: 'inherit', env });
  if (r.status !== 0) die('Build failed.');
}
const cli = (args) => { const r = spawnSync('node', ['packages/database/dist/cli.js', ...args], { env, encoding: 'utf8' }); if (r.status !== 0) die(`${args[0]} failed:\n${r.stdout}${r.stderr}`); return r.stdout.trim(); };
log('Preparing the database …'); cli(['bootstrap']); console.log('  ' + cli(['migrate'])); console.log('  ' + cli(['seed']));

// ---------- 3. start everything ----------
const kids = [];
const COLORS = { idp: 35, api: 36, worker: 33, web: 32 };
function start(name, cmd, args, cwd = ROOT) {
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${COLORS[name]}m[${name}]\x1b[0m `;
  const pipe = (s) => s.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(tag + l)));
  pipe(p.stdout); pipe(p.stderr);
  p.on('exit', (c) => { if (!stopping) console.log(`${tag}exited (${c})`); });
  kids.push(p); return p;
}
let stopping = false;
const stop = () => { stopping = true; kids.forEach((k) => k.kill('SIGTERM')); setTimeout(() => process.exit(0), 800); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

start('idp', 'node', ['tools/dev/dev-idp.mjs']);
start('api', 'node', ['apps/api/dist/main.js']);
start('worker', 'node', ['apps/worker/dist/main.js']);
start('web', 'pnpm', ['--filter', '@humantech/web', 'dev']);

// ---------- 4. demo data ----------
async function up(url) { try { return (await fetch(url)).ok; } catch { return false; } }
let ready = false;
for (let i = 0; i < 60 && !ready; i++) { ready = await up('http://localhost:4000/health/ready') && await up('http://127.0.0.1:9100/.well-known/openid-configuration'); if (!ready) await sleep(1000); }
if (!ready) die('The API did not start. Look at the [api] lines above.');
if (!flags.has('--no-demo')) { log('Creating the demo company …'); const r = spawnSync('node', ['tools/dev/demo-seed.mjs'], { env, encoding: 'utf8' }); console.log(r.stdout + r.stderr); }
console.log(`\n\x1b[1m\x1b[32m✔ humanTech is running\x1b[0m
  Open       http://localhost:3000        (home page, plans, sign-up)
  Sign in    http://localhost:3000/login  →  e-mail + password below
  Accounts   owner@demo.test  hr@demo.test  finance@demo.test  approver@demo.test  recruiter@demo.test  manager@demo.test  employee@demo.test
  Password   ${env.DEV_IDP_PASSWORD ?? 'Demo@12345'}
  Stop       Ctrl+C\n`);
