import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PermissionKey, isPermissionKey, requireMfaForCritical, sensitivityOf } from '@humantech/authz';
import { Database } from '../db';
import { ApiError, forbidden, notFound, unauthenticated } from '../common/errors';
import { NO_TENANT_KEY, PERMISSION_KEY, PUBLIC_KEY } from './decorators';
import { RequestAuth } from './auth-context';
import { TOKEN_VERIFIER, TokenVerifier, VerifiedToken } from './verifier';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(Database) private readonly db: Database,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = context.switchToHttp().getRequest<Request>();

    const header = req.header('authorization') ?? '';
    const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header);
    if (!m) throw unauthenticated();
    let token: VerifiedToken;
    try {
      token = await this.verifier.verify(m[1]!);
    } catch {
      throw unauthenticated('Invalid or expired token');
    }

    const userId = await this.resolveUser(token);
    const noTenant = this.reflector.getAllAndOverride<boolean>(NO_TENANT_KEY, targets);
    const tenantHeader = req.header('x-tenant-id');

    let auth: RequestAuth;
    if (noTenant && !tenantHeader) {
      auth = {
        tenantId: '', userId, email: token.email, requestId: req.requestId, permissions: new Set(),
        branchScope: { mode: 'listed', branchIds: new Set() }, mfaVerified: token.mfa,
      };
    } else {
      if (!tenantHeader || !UUID.test(tenantHeader)) {
        throw new ApiError('validation_failed', 422, 'X-Tenant-Id header is required', [{ path: 'x-tenant-id', message: 'a company id is required' }]);
      }
      auth = await this.loadTenantContext(tenantHeader.toLowerCase(), userId, token, req.requestId);
    }
    req.auth = auth;

    const required = this.reflector.getAllAndOverride<PermissionKey | undefined>(PERMISSION_KEY, targets);
    if (required) {
      if (!isPermissionKey(required)) throw new Error(`unknown permission on route: ${required}`);
      if (!auth.permissions.has(required)) throw forbidden();
      const mfa = requireMfaForCritical(auth, sensitivityOf(required));
      if (!mfa.allowed) throw new ApiError('mfa_required', 403, 'This action requires multi-factor authentication');
    }
    return true;
  }

  private async resolveUser(token: VerifiedToken): Promise<string> {
    const found = await this.db.pool.query<{ user_id: string; status: string }>('SELECT * FROM app.resolve_identity($1)', [token.subject]);
    let id = found.rows[0]?.user_id;
    let status = found.rows[0]?.status;
    if (!id) {
      const created = await this.db.pool.query<{ id: string }>(
        'SELECT app.upsert_user_from_identity($1,$2,$3,$4) AS id',
        [token.subject, token.email, token.name, token.emailVerified],
      );
      id = created.rows[0]!.id;
      status = 'active';
    }
    if (status === 'disabled') throw forbidden('This account is disabled');
    return id;
  }

  private async loadTenantContext(tenantId: string, userId: string, token: VerifiedToken, requestId: string): Promise<RequestAuth> {
    return this.db.run({ tenantId, userId }, async (c) => {
      const mem = await c.query<{ status: string; branch_scope_mode: 'all' | 'listed' }>(
        'SELECT status, branch_scope_mode FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
      // Not a member (or not active): indistinguishable from a company that does not exist.
      if (mem.rows[0]?.status !== 'active') throw notFound('company');

      const perms = await c.query<{ permission_key: string }>(
        `SELECT DISTINCT rp.permission_key
           FROM membership_roles mr
           JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
          WHERE mr.tenant_id = $1 AND mr.user_id = $2`, [tenantId, userId]);
      const permissions = new Set<PermissionKey>(perms.rows.map((r) => r.permission_key).filter(isPermissionKey));

      const branchIds = new Set<string>();
      if (mem.rows[0].branch_scope_mode === 'listed') {
        const b = await c.query<{ branch_id: string }>('SELECT branch_id FROM membership_branch_scopes WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
        b.rows.forEach((r) => branchIds.add(r.branch_id));
      }

      const emp = await c.query<{ id: string }>('SELECT id FROM employees WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
      const employeeId = emp.rows[0]?.id;
      let teamEmployeeIds: Set<string> | undefined;
      if (employeeId) {
        const t = await c.query<{ id: string }>('SELECT app.reports_of($1) AS id', [employeeId]);
        teamEmployeeIds = new Set(t.rows.map((r) => r.id));
      }
      return {
        tenantId, userId, employeeId, email: token.email, requestId, permissions, teamEmployeeIds,
        branchScope: mem.rows[0].branch_scope_mode === 'all' ? { mode: 'all' as const } : { mode: 'listed' as const, branchIds },
        mfaVerified: token.mfa,
      };
    });
  }
}

