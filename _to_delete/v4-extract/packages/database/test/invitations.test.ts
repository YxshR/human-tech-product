import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withContext } from '../src';
import { closePools, makeTenant, pools, sqlstate, TestTenant } from './helpers';

const sha = (s: string) => createHash('sha256').update(s).digest();
let T: TestTenant;
let other: TestTenant;
beforeAll(async () => { T = await makeTenant('inv'); other = await makeTenant('inv2'); });
afterAll(closePools);

async function invitee(): Promise<{ id: string; email: string }> {
  const sub = `invitee-${randomUUID()}`;
  const email = `${sub}@example.test`;
  const { rows } = await pools.app.query<{ id: string }>('SELECT app.upsert_user_from_identity($1,$2,$3,true) AS id', [sub, email, 'Invitee']);
  return { id: rows[0]!.id, email };
}
async function invite(email: string, opts: { expires?: Date; scope?: 'all' | 'listed'; role?: string } = {}) {
  const token = randomBytes(32).toString('base64url');
  const id = await withContext(pools.app, { tenantId: T.tenantId, userId: T.adminUserId }, async (c) => {
    const r = (await c.query<{ id: string }>(
      `INSERT INTO invitations (tenant_id,email_normalized,token_hash,branch_scope_mode,invited_by,idempotency_key,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [T.tenantId, email, sha(token), opts.scope ?? 'listed', T.adminUserId, randomUUID(), opts.expires ?? new Date(Date.now() + 86400000)])).rows[0]!;
    const role = (await c.query<{ id: string }>(`SELECT id FROM roles WHERE tenant_id=$1 AND role_key=$2`, [T.tenantId, opts.role ?? 'hr_admin'])).rows[0]!;
    await c.query('INSERT INTO invitation_roles (tenant_id,invitation_id,role_id) VALUES ($1,$2,$3)', [T.tenantId, r.id, role.id]);
    if ((opts.scope ?? 'listed') === 'listed') await c.query('INSERT INTO invitation_branch_scopes (tenant_id,invitation_id,branch_id) VALUES ($1,$2,$3)', [T.tenantId, r.id, T.branchId]);
    return r.id;
  });
  return { token, id };
}
const accept = (token: string, userId: string) => pools.app.query<{ t: string }>('SELECT app.accept_invitation($1,$2) AS t', [sha(token), userId]);

describe('app.accept_invitation', () => {
  it('creates membership, roles and scopes, and marks the invitation accepted', async () => {
    const u = await invitee();
    const inv = await invite(u.email);
    expect((await accept(inv.token, u.id)).rows[0]!.t).toBe(T.tenantId);
    await withContext(pools.app, { tenantId: T.tenantId, userId: T.adminUserId }, async (c) => {
      const m = (await c.query(`SELECT status, branch_scope_mode FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2`, [T.tenantId, u.id])).rows[0];
      expect(m).toEqual({ status: 'active', branch_scope_mode: 'listed' });
      expect((await c.query(`SELECT r.role_key FROM membership_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.user_id=$1`, [u.id])).rows).toEqual([{ role_key: 'hr_admin' }]);
      expect((await c.query(`SELECT branch_id FROM membership_branch_scopes WHERE user_id=$1`, [u.id])).rows).toEqual([{ branch_id: T.branchId }]);
      expect((await c.query(`SELECT status FROM invitations WHERE id=$1`, [inv.id])).rows[0]!.status).toBe('accepted');
      expect((await c.query(`SELECT 1 FROM audit_logs WHERE entity_id=$1 AND action='invitation.accept' AND actor_user_id=$2`, [inv.id, u.id])).rowCount).toBe(1);
    });
  });
  it('cannot be accepted twice', async () => {
    const u = await invitee();
    const inv = await invite(u.email);
    await accept(inv.token, u.id);
    expect(await sqlstate(() => accept(inv.token, u.id))).toBe('HT003');
  });
  it('rejects a different e-mail address', async () => {
    const u = await invitee(); const v = await invitee();
    const inv = await invite(u.email);
    expect(await sqlstate(() => accept(inv.token, v.id))).toBe('HT003');
  });
  it('rejects an expired invitation', async () => {
    const u = await invitee();
    const inv = await invite(u.email, { expires: new Date(Date.now() - 1000) });
    expect(await sqlstate(() => accept(inv.token, u.id))).toBe('HT003');
  });
  it('rejects an unknown token', async () => {
    const u = await invitee();
    expect(await sqlstate(() => accept(randomBytes(32).toString('base64url'), u.id))).toBe('HT003');
  });
  it('rejects a revoked invitation', async () => {
    const u = await invitee();
    const inv = await invite(u.email);
    await withContext(pools.app, { tenantId: T.tenantId, userId: T.adminUserId }, (c) => c.query(`UPDATE invitations SET status='revoked' WHERE id=$1`, [inv.id]));
    expect(await sqlstate(() => accept(inv.token, u.id))).toBe('HT003');
  });
  it('does not leave tenant context behind, and invitations stay invisible to other tenants', async () => {
    const u = await invitee();
    const inv = await invite(u.email);
    const c = await pools.app.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT app.accept_invitation($1,$2)', [sha(inv.token), u.id]);
      expect((await c.query(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t).toBeFalsy();
      await c.query('COMMIT');
    } finally { c.release(); }
    const seen = await withContext(pools.app, { tenantId: other.tenantId, userId: other.adminUserId }, async (cc) => (await cc.query('SELECT count(*)::int n FROM invitations')).rows[0].n);
    expect(seen).toBe(0);
    // Without the function there is no way for the runtime role to read invitations by token.
    expect((await pools.app.query('SELECT count(*)::int n FROM invitations')).rows[0].n).toBe(0);
  });
  it('is not executable by PUBLIC-only roles (system role cannot call it)', async () => {
    const u = await invitee(); const inv = await invite(u.email);
    expect(await sqlstate(() => pools.system.query('SELECT app.accept_invitation($1,$2)', [sha(inv.token), u.id]))).toBe('42501');
  });
});
