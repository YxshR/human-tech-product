import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PERMISSION_KEYS, isPermissionKey } from '@humantech/authz';
import { AccessUserView, InvitationView, RoleView, acceptInvitation, createRole, inviteUser, setBranchScope, setUserRoles, updateRole } from '@humantech/contracts';
import { PostgresJobProducer } from '@humantech/jobs';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { ApiError, forbidden, notFound } from '../common/errors';
import { setClause } from '../common/sql';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest();
const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });

@Injectable()
export class AccessService {
  private readonly producer = new PostgresJobProducer();
  constructor(@Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService) {}

  // ---- reads ----------------------------------------------------------------------------------
  async listUsers(a: RequestAuth): Promise<AccessUserView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const rows = (await c.query(
        `SELECT m.user_id, u.email_normalized AS email, u.display_name, m.status, m.branch_scope_mode,
                to_char(m.joined_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS joined_at,
                COALESCE((SELECT array_agg(r.role_key ORDER BY r.role_key) FROM membership_roles mr JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id
                           WHERE mr.tenant_id=m.tenant_id AND mr.user_id=m.user_id), '{}') AS role_keys,
                COALESCE((SELECT array_agg(s.branch_id) FROM membership_branch_scopes s WHERE s.tenant_id=m.tenant_id AND s.user_id=m.user_id), '{}') AS branches,
                (SELECT e.id FROM employees e WHERE e.tenant_id=m.tenant_id AND e.user_id=m.user_id) AS employee_id
           FROM tenant_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id=$1 AND m.status <> 'removed' ORDER BY u.email_normalized`, [a.tenantId])).rows;
      return rows.map((r) => ({
        userId: r.user_id, email: r.email, displayName: r.display_name, status: r.status, roleKeys: r.role_keys,
        branchScope: r.branch_scope_mode === 'all' ? ('all' as const) : (r.branches as string[]), employeeId: r.employee_id, joinedAt: r.joined_at,
      }));
    });
  }

  async listRoles(a: RequestAuth): Promise<RoleView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT r.id, r.role_key AS key, r.name, r.is_system_role AS is_system,
              COALESCE((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) FROM role_permissions rp WHERE rp.tenant_id=r.tenant_id AND rp.role_id=r.id), '{}') AS permissions,
              (SELECT count(*)::int FROM membership_roles mr WHERE mr.tenant_id=r.tenant_id AND mr.role_id=r.id) AS member_count
         FROM roles r WHERE r.tenant_id=$1 ORDER BY r.is_system_role DESC, r.name`, [a.tenantId])).rows
      .map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.is_system, permissions: r.permissions, memberCount: r.member_count })));
  }

  async listInvitations(a: RequestAuth): Promise<InvitationView[]> {
    return this.db.run(ctxOf(a), async (c) => (await c.query(
      `SELECT i.id, i.email_normalized AS email,
              CASE WHEN i.status='pending' AND i.expires_at < now() THEN 'expired' ELSE i.status END AS status,
              to_char(i.expires_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at, i.branch_scope_mode,
              COALESCE((SELECT array_agg(r.role_key ORDER BY r.role_key) FROM invitation_roles ir JOIN roles r ON r.tenant_id=ir.tenant_id AND r.id=ir.role_id WHERE ir.tenant_id=i.tenant_id AND ir.invitation_id=i.id), '{}') AS role_keys,
              COALESCE((SELECT array_agg(b.branch_id) FROM invitation_branch_scopes b WHERE b.tenant_id=i.tenant_id AND b.invitation_id=i.id), '{}') AS branches
         FROM invitations i WHERE i.tenant_id=$1 ORDER BY i.created_at DESC LIMIT 200`, [a.tenantId])).rows
      .map((r) => ({ id: r.id, email: r.email, status: r.status, expiresAt: r.expires_at, roleKeys: r.role_keys, branchScope: r.branch_scope_mode === 'all' ? ('all' as const) : (r.branches as string[]) })));
  }

  // ---- helpers ---------------------------------------------------------------------------------
  private async roleIds(c: PoolClient, tenantId: string, keys: string[]): Promise<Map<string, string>> {
    const rows = (await c.query<{ id: string; role_key: string }>('SELECT id, role_key FROM roles WHERE tenant_id=$1 AND role_key = ANY($2)', [tenantId, keys])).rows;
    const missing = keys.filter((k) => !rows.some((r) => r.role_key === k));
    if (missing.length) throw new ApiError('validation_failed', 422, `Unknown role(s): ${missing.join(', ')}`, [{ path: 'roleKeys', message: 'unknown role' }]);
    return new Map(rows.map((r) => [r.role_key, r.id]));
  }

  /** Never leave a company without anyone who can manage roles. */
  private async assertManagerRemains(c: PoolClient, tenantId: string): Promise<void> {
    const n = (await c.query<{ n: number }>(
      `SELECT count(DISTINCT m.user_id)::int n FROM tenant_memberships m
         JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.user_id=m.user_id
         JOIN role_permissions rp ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id AND rp.permission_key='role.manage'
        WHERE m.tenant_id=$1 AND m.status='active'`, [tenantId])).rows[0]!.n;
    if (n < 1) throw new ApiError('conflict', 409, 'This change would leave the company with nobody who can manage roles');
  }

  private async assertBranchesBelong(c: PoolClient, tenantId: string, ids: string[]): Promise<void> {
    const n = (await c.query<{ n: number }>('SELECT count(*)::int n FROM branches WHERE tenant_id=$1 AND id = ANY($2::uuid[])', [tenantId, ids])).rows[0]!.n;
    if (n !== new Set(ids).size) throw new ApiError('validation_failed', 422, 'One or more branches do not exist', [{ path: 'branchScope', message: 'unknown branch' }]);
  }

  private assertScopeWithin(a: RequestAuth, scope: 'all' | string[]): void {
    if (a.branchScope.mode === 'all') return;
    if (scope === 'all' || scope.some((b) => !(a.branchScope as { branchIds: ReadonlySet<string> }).branchIds.has(b))) {
      throw forbidden('You can only grant access to branches you can access yourself');
    }
  }

  // ---- invitations ------------------------------------------------------------------------------
  async invite(a: RequestAuth, body: unknown, idempotencyKey?: string): Promise<{ invitation: InvitationView; token: string }> {
    const b = inviteUser.parse(body);
    this.assertScopeWithin(a, b.branchScope);
    const token = randomBytes(32).toString('base64url');
    return this.db.run(ctxOf(a, 'invite user'), async (c) => {
      const ids = await this.roleIds(c, a.tenantId, b.roleKeys);
      if (b.branchScope !== 'all') await this.assertBranchesBelong(c, a.tenantId, b.branchScope);
      const existing = await c.query(
        `SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.email_normalized=$2 AND m.status IN ('active','suspended')`, [a.tenantId, b.email]);
      if (existing.rowCount) throw new ApiError('conflict', 409, 'This person is already a member of the company');
      // Expire stale pending invitations for this email so a fresh one can be issued.
      await c.query(`UPDATE invitations SET status='expired' WHERE tenant_id=$1 AND email_normalized=$2 AND status='pending' AND expires_at < now()`, [a.tenantId, b.email]);
      const expires = new Date(Date.now() + INVITE_TTL_MS);
      const inv = (await c.query<{ id: string }>(
        `INSERT INTO invitations (tenant_id, email_normalized, token_hash, branch_scope_mode, invited_by, idempotency_key, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [a.tenantId, b.email, sha(token), b.branchScope === 'all' ? 'all' : 'listed', a.userId, idempotencyKey ?? randomBytes(16).toString('hex'), expires])).rows[0]!;
      for (const k of b.roleKeys) await c.query('INSERT INTO invitation_roles (tenant_id, invitation_id, role_id) VALUES ($1,$2,$3)', [a.tenantId, inv.id, ids.get(k)]);
      if (b.branchScope !== 'all') for (const br of new Set(b.branchScope)) await c.query('INSERT INTO invitation_branch_scopes (tenant_id, invitation_id, branch_id) VALUES ($1,$2,$3)', [a.tenantId, inv.id, br]);
      // The e-mail job carries the secret only until it is sent (the handler scrubs it).
      await this.producer.enqueue(c, {
        tenantId: a.tenantId, type: 'invitation.email', aggregateType: 'invitations', aggregateId: inv.id, idempotencyKey: `invitation-email:${inv.id}`,
        payload: { email: b.email, token, expiresAt: expires.toISOString() }, correlationId: a.requestId,
      });
      await this.audit.record(c, a, 'invitation.create', 'invitations', inv.id, null, { email: b.email, roleKeys: b.roleKeys, branchScope: b.branchScope });
      return {
        token,
        invitation: { id: inv.id, email: b.email, status: 'pending', expiresAt: expires.toISOString(), roleKeys: [...b.roleKeys].sort(), branchScope: b.branchScope },
      };
    });
  }

  async revokeInvitation(a: RequestAuth, id: string): Promise<void> {
    await this.db.run(ctxOf(a), async (c) => {
      const r = await c.query(`UPDATE invitations SET status='revoked' WHERE tenant_id=$1 AND id=$2 AND status='pending' RETURNING email_normalized`, [a.tenantId, id]);
      if (!r.rowCount) throw notFound('pending invitation');
      await this.audit.record(c, a, 'invitation.revoke', 'invitations', id, { email: r.rows[0].email_normalized }, null);
    });
  }

  /** Called by the invitee (no company selected yet). */
  async accept(userId: string, body: unknown): Promise<{ tenantId: string }> {
    const b = acceptInvitation.parse(body);
    const row = await this.db.run({ userId }, async (c) => (await c.query<{ t: string }>('SELECT app.accept_invitation($1,$2) AS t', [sha(b.token), userId])).rows[0]!);
    return { tenantId: row.t };
  }

  // ---- members ----------------------------------------------------------------------------------
  private async memberOrThrow(c: PoolClient, tenantId: string, userId: string): Promise<{ status: string }> {
    const m = (await c.query<{ status: string }>('SELECT status FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [tenantId, userId])).rows[0];
    if (!m || m.status === 'removed') throw notFound('user');
    return m;
  }

  async setRoles(a: RequestAuth, userId: string, body: unknown): Promise<AccessUserView> {
    const b = setUserRoles.parse(body);
    if (userId === a.userId) throw forbidden('You cannot change your own roles');
    await this.db.run(ctxOf(a, 'roles changed'), async (c) => {
      await this.memberOrThrow(c, a.tenantId, userId);
      const wanted = await this.roleIds(c, a.tenantId, b.roleKeys);
      const before = (await c.query<{ role_key: string }>(
        'SELECT r.role_key FROM membership_roles mr JOIN roles r ON r.tenant_id=mr.tenant_id AND r.id=mr.role_id WHERE mr.tenant_id=$1 AND mr.user_id=$2', [a.tenantId, userId])).rows.map((r) => r.role_key);
      await c.query('DELETE FROM membership_roles WHERE tenant_id=$1 AND user_id=$2 AND role_id <> ALL($3::uuid[])', [a.tenantId, userId, [...wanted.values()]]);
      for (const id of wanted.values()) await c.query('INSERT INTO membership_roles (tenant_id,user_id,role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [a.tenantId, userId, id]);
      await this.assertManagerRemains(c, a.tenantId);
      await this.audit.record(c, a, 'membership.roles', 'tenant_memberships', null, { userId, roleKeys: before.sort() }, { userId, roleKeys: [...b.roleKeys].sort() });
    });
    return (await this.listUsers(a)).find((u) => u.userId === userId)!;
  }

  async setScope(a: RequestAuth, userId: string, body: unknown): Promise<AccessUserView> {
    const b = setBranchScope.parse(body);
    if (userId === a.userId) throw forbidden('You cannot change your own branch scope');
    this.assertScopeWithin(a, b.scope);
    await this.db.run(ctxOf(a, 'scope changed'), async (c) => {
      await this.memberOrThrow(c, a.tenantId, userId);
      if (b.scope !== 'all') await this.assertBranchesBelong(c, a.tenantId, b.scope);
      await c.query('DELETE FROM membership_branch_scopes WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, userId]);
      if (b.scope !== 'all') for (const br of new Set(b.scope)) await c.query('INSERT INTO membership_branch_scopes (tenant_id,user_id,branch_id) VALUES ($1,$2,$3)', [a.tenantId, userId, br]);
      await c.query('UPDATE tenant_memberships SET branch_scope_mode=$3 WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, userId, b.scope === 'all' ? 'all' : 'listed']);
      await this.audit.record(c, a, 'membership.scope', 'tenant_memberships', null, null, { userId, scope: b.scope });
    });
    return (await this.listUsers(a)).find((u) => u.userId === userId)!;
  }

  async setStatus(a: RequestAuth, userId: string, status: 'suspended' | 'active'): Promise<AccessUserView> {
    if (userId === a.userId) throw forbidden('You cannot suspend yourself');
    await this.db.run(ctxOf(a, `membership ${status}`), async (c) => {
      const m = await this.memberOrThrow(c, a.tenantId, userId);
      if (m.status === status) return;
      await c.query('UPDATE tenant_memberships SET status=$3, revoked_at=$4 WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, userId, status, status === 'suspended' ? new Date() : null]);
      if (status === 'suspended') {
        await c.query(`UPDATE user_sessions SET revoked_at=now(), revoked_reason='membership suspended' WHERE user_id=$1 AND revoked_at IS NULL`, [userId]).catch(() => undefined);
        await this.assertManagerRemains(c, a.tenantId);
      }
      await this.audit.record(c, a, `membership.${status}`, 'tenant_memberships', null, { userId, status: m.status }, { userId, status });
    });
    return (await this.listUsers(a)).find((u) => u.userId === userId)!;
  }

  // ---- custom roles -----------------------------------------------------------------------------
  private assertGrantable(a: RequestAuth, permissions: string[]): void {
    const unknown = permissions.filter((p) => !isPermissionKey(p));
    if (unknown.length) throw new ApiError('validation_failed', 422, `Unknown permission(s): ${unknown.join(', ')}`, [{ path: 'permissions', message: 'unknown permission' }]);
    const beyond = permissions.filter((p) => !a.permissions.has(p as never));
    if (beyond.length) throw forbidden(`You cannot grant permissions you do not hold: ${beyond.slice(0, 5).join(', ')}`);
  }

  async createRole(a: RequestAuth, body: unknown): Promise<RoleView> {
    const b = createRole.parse(body);
    const permissions = [...new Set(b.permissions)];
    this.assertGrantable(a, permissions);
    const id = await this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query<{ id: string }>('INSERT INTO roles (tenant_id, role_key, name, is_system_role) VALUES ($1,$2,$3,false) RETURNING id', [a.tenantId, b.key, b.name])).rows[0]!;
      await c.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) SELECT $1,$2,unnest($3::text[])', [a.tenantId, r.id, permissions]);
      await this.audit.record(c, a, 'role.create', 'roles', r.id, null, { key: b.key, permissions });
      return r.id;
    });
    return (await this.listRoles(a)).find((r) => r.id === id)!;
  }

  async updateRole(a: RequestAuth, id: string, body: unknown): Promise<RoleView> {
    const b = updateRole.parse(body);
    if (!b.name && !b.permissions) throw new ApiError('validation_failed', 422, 'Nothing to update');
    const permissions = b.permissions ? [...new Set(b.permissions)] : undefined;
    if (permissions) this.assertGrantable(a, permissions);
    await this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query<{ is_system_role: boolean; name: string }>('SELECT is_system_role, name FROM roles WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('role');
      if (cur.is_system_role) throw new ApiError('invalid_state', 409, 'System roles cannot be edited; create a custom role instead');
      if (b.name) { const s = setClause({ name: b.name }, 3); await c.query(`UPDATE roles SET ${s.sql} WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, ...s.params]); }
      if (permissions) {
        await c.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2 AND permission_key <> ALL($3::text[])', [a.tenantId, id, permissions]);
        await c.query('INSERT INTO role_permissions (tenant_id, role_id, permission_key) SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING', [a.tenantId, id, permissions]);
        // Holders' cached grants are stale now.
        await c.query('UPDATE tenant_memberships SET permission_version = permission_version + 1 WHERE tenant_id=$1 AND user_id IN (SELECT user_id FROM membership_roles WHERE tenant_id=$1 AND role_id=$2)', [a.tenantId, id]);
        await this.assertManagerRemains(c, a.tenantId);
      }
      await this.audit.record(c, a, 'role.update', 'roles', id, { name: cur.name }, { name: b.name ?? cur.name, permissions });
    });
    return (await this.listRoles(a)).find((r) => r.id === id)!;
  }

  async deleteRole(a: RequestAuth, id: string): Promise<void> {
    await this.db.run(ctxOf(a), async (c) => {
      const cur = (await c.query<{ is_system_role: boolean; key: string; n: number }>(
        `SELECT is_system_role, role_key AS key, (SELECT count(*)::int FROM membership_roles WHERE tenant_id=$1 AND role_id=$2) n FROM roles WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!cur) throw notFound('role');
      if (cur.is_system_role) throw new ApiError('invalid_state', 409, 'System roles cannot be deleted');
      if (cur.n > 0) throw new ApiError('conflict', 409, `${cur.n} user(s) still hold this role`);
      await c.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2', [a.tenantId, id]);
      await c.query('DELETE FROM roles WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
      await this.audit.record(c, a, 'role.delete', 'roles', id, { key: cur.key }, null);
    });
  }

  permissionCatalogue(): string[] { return [...PERMISSION_KEYS]; }
}
