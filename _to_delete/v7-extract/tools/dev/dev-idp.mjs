#!/usr/bin/env node
/**
 * DEVELOPER-ONLY sign-in server. A tiny OpenID Connect provider with an e-mail + password form, so you can try every role
 * on your own machine without Auth0/Keycloak/etc. It is NOT part of the product and never ships in the Docker images.
 * Refuses to run when NODE_ENV=production. Binds to 127.0.0.1 only.
 *
 *   pnpm dev:idp                     # http://127.0.0.1:9100
 * Then set  OIDC_ISSUER=http://127.0.0.1:9100  OIDC_AUDIENCE=humantech-api  OIDC_CLIENT_ID=web  (see .env.example)
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

if (process.env.NODE_ENV === 'production') { console.error('dev-idp refuses to run in production.'); process.exit(1); }
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { SignJWT, exportJWK, generateKeyPair } = require('jose');

const PORT = Number(process.env.DEV_IDP_PORT ?? 9100);
const ISS = `http://127.0.0.1:${PORT}`;
const AUD = process.env.OIDC_AUDIENCE ?? 'humantech-api';
export const PASSWORD = process.env.DEV_IDP_PASSWORD ?? 'Demo@12345';
const USERS = ['owner', 'hr', 'finance', 'approver', 'recruiter', 'manager', 'employee'].map((n) => `${n}@demo.test`);

const kid = 'dev-' + randomBytes(4).toString('hex');
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
const sign = (email) => new SignJWT({ email, email_verified: true, name: email.split('@')[0], amr: ['pwd', 'mfa'] })
  .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(ISS).setAudience(AUD).setSubject(`dev-${email}`).setIssuedAt().setExpirationTime('1h').sign(privateKey);
const codes = new Map();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const page = (q, error) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Developer sign-in</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f4f5fb;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #e3e5f0;border-radius:18px;padding:30px;width:min(420px,92vw);box-shadow:0 10px 30px rgba(40,40,90,.1)}
h1{margin:0 0 4px;font-size:22px}p{color:#667}label{display:block;font-weight:600;margin:14px 0 4px}input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cfd3e6;border-radius:10px;font:inherit}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font:inherit;font-weight:650;cursor:pointer}.err{background:#fde8e8;color:#9b1c1c;padding:10px 12px;border-radius:10px;margin-top:12px}
.tag{display:inline-block;background:#fff3cd;color:#7a5b00;border-radius:99px;padding:2px 10px;font-size:12px;font-weight:650}ul{padding-left:18px;color:#556;font-size:13px}code{background:#eef;padding:1px 5px;border-radius:5px}a.u{color:#4f46e5;cursor:pointer;text-decoration:underline}</style>
<main><span class="tag">DEVELOPER SIGN-IN · local only</span><h1>Sign in</h1><p>Test accounts for humanTech. Password for all: <code>${esc(PASSWORD)}</code></p>
<form method="post" action="/authorize">${['client_id', 'redirect_uri', 'state', 'code_challenge', 'scope', 'response_type'].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k))}">`).join('')}
<label for="e">E-mail</label><input id="e" name="email" type="email" required autofocus value="${esc(q.get('email') ?? 'owner@demo.test')}">
<label for="p">Password</label><input id="p" name="password" type="password" required>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<button>Sign in</button></form><ul>${USERS.map((u) => `<li><a class="u" onclick="document.getElementById('e').value='${u}';document.getElementById('p').value='${esc(PASSWORD)}'">${u}</a></li>`).join('')}</ul></main></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, ISS);
  const json = (o, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  const body = async () => { let b = ''; for await (const c of req) b += c; return new URLSearchParams(b); };
  if (u.pathname === '/.well-known/openid-configuration') return json({ issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/.well-known/jwks.json` });
  if (u.pathname === '/.well-known/jwks.json') return json({ keys: [jwk] });
  if (u.pathname === '/authorize' && req.method === 'GET') { res.setHeader('content-type', 'text/html'); return res.end(page(u.searchParams)); }
  if (u.pathname === '/authorize' && req.method === 'POST') {
    const p = await body(); const email = String(p.get('email') ?? '').trim().toLowerCase();
    if (!USERS.includes(email) || p.get('password') !== PASSWORD) { res.statusCode = 401; res.setHeader('content-type', 'text/html'); return res.end(page(p, 'Wrong e-mail or password.')); }
    const code = randomBytes(16).toString('hex'); codes.set(code, email); setTimeout(() => codes.delete(code), 120_000);
    res.statusCode = 302; res.setHeader('location', `${p.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(p.get('state') ?? '')}`); return res.end();
  }
  if (u.pathname === '/token' && req.method === 'POST') {
    const p = await body();
    const email = p.get('grant_type') === 'refresh_token' ? String(p.get('refresh_token') ?? '').replace(/^r-/, '') : codes.get(p.get('code'));
    if (!email || !USERS.includes(email)) return json({ error: 'invalid_grant' }, 400);
    codes.delete(p.get('code'));
    return json({ access_token: await sign(email), token_type: 'Bearer', expires_in: 3600, refresh_token: `r-${email}` });
  }
  // Used by the demo-data script only (it has no browser).
  if (u.pathname === '/_token') { const e = u.searchParams.get('email'); return USERS.includes(e) ? json({ token: await sign(e) }) : json({ error: 'unknown user' }, 404); }
  res.statusCode = 404; res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`Developer sign-in server on ${ISS}\nAccounts: ${USERS.join(', ')}\nPassword: ${PASSWORD}`));
