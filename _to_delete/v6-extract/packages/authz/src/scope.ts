import { PermissionKey } from './permissions';

/**
 * Everything the authorisation layer needs to know about the caller, resolved server-side
 * from a verified session + active membership. Never built from browser input.
 */
export interface AuthContext {
  tenantId: string;
  userId: string;
  /** The caller's own employee record in this tenant, if they have one. */
  employeeId?: string;
  permissions: ReadonlySet<PermissionKey>;
  branchScope: { mode: 'all' } | { mode: 'listed'; branchIds: ReadonlySet<string> };
  /** Employee ids the caller manages directly or indirectly (resolved via app.reports_of). */
  teamEmployeeIds?: ReadonlySet<string>;
  mfaVerified: boolean;
}

export interface ResourceRef {
  tenantId: string;
  branchId?: string | null;
  employeeId?: string | null;
}

export type Decision = { allowed: true } | { allowed: false; reason: DenyReason };
export type DenyReason =
  | 'wrong_tenant'
  | 'missing_permission'
  | 'outside_branch_scope'
  | 'outside_team_scope'
  | 'not_owner'
  | 'mfa_required'
  | 'same_actor';

const allow: Decision = { allowed: true };
const deny = (reason: DenyReason): Decision => ({ allowed: false, reason });

export function hasPermission(ctx: AuthContext, permission: PermissionKey): boolean {
  return ctx.permissions.has(permission);
}

/** Tenant boundary first: a record from another tenant is denied before anything else. */
export function inTenant(ctx: AuthContext, resource: ResourceRef): Decision {
  return resource.tenantId === ctx.tenantId ? allow : deny('wrong_tenant');
}

export function inBranchScope(ctx: AuthContext, resource: ResourceRef): Decision {
  if (ctx.branchScope.mode === 'all') return allow;
  if (!resource.branchId) return deny('outside_branch_scope');
  return ctx.branchScope.branchIds.has(resource.branchId) ? allow : deny('outside_branch_scope');
}

/**
 * Can the caller exercise `permission` on this employee-related record?
 * Order: tenant -> permission -> (own record | branch scope | team scope).
 * `teamPermissions` lets a manager act on their reports even outside listed branches.
 */
export function authorizeOnEmployee(
  ctx: AuthContext,
  permission: PermissionKey,
  resource: ResourceRef,
  opts: { allowOwn?: PermissionKey; allowTeam?: boolean } = {},
): Decision {
  const t = inTenant(ctx, resource);
  if (!t.allowed) return t;

  if (opts.allowOwn && resource.employeeId && resource.employeeId === ctx.employeeId && hasPermission(ctx, opts.allowOwn)) {
    return allow;
  }
  if (!hasPermission(ctx, permission)) return deny('missing_permission');

  const branch = inBranchScope(ctx, resource);
  if (branch.allowed) return allow;

  if (opts.allowTeam && resource.employeeId && ctx.teamEmployeeIds?.has(resource.employeeId)) return allow;
  return opts.allowTeam ? deny('outside_team_scope') : branch;
}

/** Segregation of duties: the checker must not be the maker. */
export function differentActors(maker: string | null | undefined, checker: string): Decision {
  return maker && maker === checker ? deny('same_actor') : allow;
}

/** Critical actions require a session that has completed MFA. */
export function requireMfaForCritical(ctx: AuthContext, sensitivity: 'normal' | 'sensitive' | 'critical'): Decision {
  return sensitivity === 'critical' && !ctx.mfaVerified ? deny('mfa_required') : allow;
}

/**
 * Responses to unauthorised access must not reveal whether a record exists in another
 * tenant/scope: wrong-tenant and out-of-scope map to 404, missing permission to 403.
 */
export function httpStatusFor(reason: DenyReason): 403 | 404 {
  return reason === 'wrong_tenant' || reason === 'outside_branch_scope' || reason === 'outside_team_scope' ? 404 : 403;
}
