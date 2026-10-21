#!/usr/bin/env node
// DEV-ONLY mock OpenID Connect provider (no Docker, no dependencies). NEVER use outside local development:
// it signs in anyone who types an e-mail address.
// Usage: node scripts/dev-idp.mjs   (env: IDP_PORT=9000, OIDC_AUDIENCE=humantech-api, OIDC_CLIENT_ID=humantech-web)
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.IDP_PORT ?? 9000);
const ISSUER = `http://localhost:${PORT}`;
const AUD = process.env.OIDC_AUDIENCE ?? 'humantech-api';
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'humantech-web';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'dev-idp-key';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

const b64 = (b) => Buffer.from(b).toString('base64url');
function sign(claims) {
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64(JSON.stringify(claims));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64(sig)}`;
}
function tokensFor(email, aud) {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    iss: ISSUER, sub: `dev|${email}`, email, email_verified: true, name: email.split('@')[0],
    amr: ['pwd', 'mfa'], iat: now, exp: now + 3600,
  };
  return {
    access_token: sign({ ...base, aud }),
    id_token: sign({ ...base, aud: CLIENT_ID }),
    refresh_token: b64(JSON.stringify({ email })),
    token_type: 'Bearer', expires_in: 3600,
  };
}

const codes = new Map(); // code -> { email, challenge, redirect }
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(new URLSearchParams(s))); });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const page = (q) => `<!doctype html><meta charset=utf-8><title>Dev sign-in</title>
<body style="font-family:system-ui;max-width:380px;margin:12vh auto;padding:0 16px">
<h2>Dev sign-in</h2><p style="color:#666">Mock identity provider (local development only).</p>
<form method=post action=/authorize>
${[...q.entries()].map(([k, v]) => `<input type=hidden name="${esc(k)}" value="${esc(v)}">`).join('')}
<input name=email type=email required autofocus placeholder="you@example.com" style="width:100%;padding:10px;font-size:16px;box-sizing:border-box">
<button style="margin-top:12px;padding:10px 16px;font-size:16px">Sign in</button></form></body>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(res, 200, {
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`, end_session_endpoint: `${ISSUER}/logout`,
      response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'], subject_types_supported: ['public'],
    });
  }
  if (url.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] });
  if (url.pathname === '/authorize' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(page(url.searchParams));
  }
  if (url.pathname === '/authorize' && req.method === 'POST') {
    const f = await readBody(req);
    const code = crypto.randomBytes(16).toString('hex');
    codes.set(code, { email: f.get('email'), challenge: f.get('code_challenge'), redirect: f.get('redirect_uri') });
    const back = new URL(f.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', f.get('state') ?? '');
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const f = await readBody(req);
    if (f.get('grant_type') === 'refresh_token') {
      try {
        const { email } = JSON.parse(Buffer.from(f.get('refresh_token'), 'base64url').toString());
        return json(res, 200, tokensFor(email, AUD));
      } catch { return json(res, 400, { error: 'invalid_grant' }); }
    }
    const entry = codes.get(f.get('code'));
    codes.delete(f.get('code'));
    const ok = entry && crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === entry.challenge;
    if (!ok) return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, tokensFor(entry.email, AUD));
  }
  if (url.pathname === '/logout') {
    const to = url.searchParams.get('post_logout_redirect_uri');
    res.writeHead(302, { Location: to ?? '/' });
    return res.end();
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`dev IdP on ${ISSUER} (audience ${AUD}, client ${CLIENT_ID})`));
