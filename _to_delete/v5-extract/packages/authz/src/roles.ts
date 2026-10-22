import { PERMISSION_KEYS, PermissionKey } from './permissions';

/**
 * Tenant roles. "Platform Admin / Support" are humantech staff (platform_staff table) and
 * are deliberately NOT tenant roles: they never browse tenant data except through an
 * approved, time-limited support grant (see support_access_grants).
 *
 * Reconciliation of the two source documents: the starter CSV listed six role columns, the
 * blueprint listed ten roles. The ten are kept; "Finance/Payroll" is split into preparer and
 * approver so segregation of duties is structural, not a policy hope.
 */
export type RoleKey =
  | 'company_admin'
  | 'hr_admin'
  | 'recruiter'
  | 'finance_payroll'
  | 'payroll_approver'
  | 'store_manager'
  | 'department_manager'
  | 'employee'
  | 'auditor';

/** How far a role's record visibility reaches by default. */
export type ScopeKind = 'tenant' | 'branches' | 'team' | 'self';

export interface RoleDefinition {
  name: string;
  description: string;
  scope: ScopeKind;
  /** Roles that must sign in with MFA (blueprint 17.1). */
  requiresMfa: boolean;
  permissions: readonly PermissionKey[];
}

const SELF_SERVICE: PermissionKey[] = [
  'profile.read_own',
  'profile.request_change',
  'attendance.read_own',
  'attendance.checkin_own',
  'attendance.request_correction_own',
  'leave.read_own',
  'leave.request',
  'payslip.read_own',
  'audit.read_own',
];

export const ROLES: Record<RoleKey, RoleDefinition> = {
  company_admin: {
    name: 'Company Admin',
    description:
      'Runs the company workspace: users, roles, branches, settings. Does NOT receive bank, tax, salary or payroll permissions by default - those must be granted explicitly.',
    scope: 'tenant',
    requiresMfa: true,
    permissions: [
      'tenant.read', 'tenant.update', 'settings.manage',
      'user.read', 'user.invite', 'user.manage', 'role.read', 'role.manage', 'support.grant_access',
      'branch.read', 'branch.create', 'branch.update', 'branch.assign_manager',
      'org.read', 'org.manage',
      'employee.read', 'employee.create', 'employee.update', 'employee.archive', 'employee.exit',
      'employee.read_sensitive', 'employee.update_sensitive', 'employee.export',
      'onboarding.read', 'onboarding.manage', 'document.read', 'document.upload', 'document.delete',
      'candidate.read', 'candidate.create', 'candidate.update', 'candidate.change_stage', 'candidate.convert',
      'candidate.export', 'recruitment.manage',
      'attendance.read', 'attendance.mark', 'attendance.correct', 'attendance.approve_correction',
      'attendance.manage_policy',
      'leave.read_all', 'leave.approve', 'leave.reject', 'leave.manage_policy',
      'profile.review_change',
      'report.read', 'view.manage_shared', 'import.create', 'import.commit', 'export.create',
      'audit.read', 'custom_field.manage', 'approval.manage_workflows', 'notification.manage_templates',
      'privacy.manage', 'subscription.read', 'subscription.manage',
      ...SELF_SERVICE,
    ],
  },
  hr_admin: {
    name: 'HR Admin',
    description: 'Employee master, onboarding, leave and attendance administration. No payroll or bank data.',
    scope: 'tenant',
    requiresMfa: true,
    permissions: [
      'tenant.read', 'branch.read', 'org.read', 'org.manage',
      'employee.read', 'employee.create', 'employee.update', 'employee.archive', 'employee.exit',
      'employee.read_sensitive', 'employee.update_sensitive', 'employee.read_identifiers', 'employee.export',
      'onboarding.read', 'onboarding.manage', 'document.read', 'document.upload', 'document.delete',
      'attendance.read', 'attendance.mark', 'attendance.correct', 'attendance.approve_correction',
      'attendance.manage_policy',
      'leave.read_all', 'leave.approve', 'leave.reject', 'leave.adjust_balance', 'leave.manage_policy',
      'profile.review_change', 'report.read', 'import.create', 'import.commit', 'export.create',
      'audit.read', 'privacy.manage', 'user.read', 'role.read',
      ...SELF_SERVICE,
    ],
  },
  recruiter: {
    name: 'Recruiter',
    description: 'Candidate pipeline and (if granted) conversion to employee. No employee compensation.',
    scope: 'tenant',
    requiresMfa: false,
    permissions: [
      'tenant.read', 'branch.read',
      'candidate.read', 'candidate.create', 'candidate.update', 'candidate.change_stage',
      'candidate.convert', 'candidate.export', 'recruitment.manage', 'candidate.read_salary',
      'import.create', 'import.commit', 'export.create', 'report.read',
      ...SELF_SERVICE,
    ],
  },
  finance_payroll: {
    name: 'Finance / Payroll Preparer',
    description:
      'Prepares payroll: salary structures, assignments, runs and calculation. Cannot approve or finalise what they prepare.',
    scope: 'tenant',
    requiresMfa: true,
    permissions: [
      'tenant.read', 'branch.read', 'org.read',
      'employee.read', 'employee.read_identifiers', 'employee.read_bank', 'employee.update_bank',
      'attendance.read', 'leave.read_all',
      'salary_structure.read', 'salary_structure.manage', 'salary.read_assignment', 'salary.assign',
      'payroll.read', 'payroll.manage_settings', 'payroll.create_run', 'payroll.calculate',
      'payroll.resolve_exception', 'payroll.submit', 'payroll.manage_adjustments', 'payroll.correct',
      'payroll.export', 'payslip.read_any', 'payslip.generate',
      'attendance.lock', 'report.read', 'export.create', 'export.sensitive',
      'invoice.read', 'invoice.create', 'invoice.issue', 'invoice.void', 'invoice.record_payment',
      'audit.read',
      ...SELF_SERVICE,
    ],
  },
  payroll_approver: {
    name: 'Payroll Approver',
    description: 'The checker: reviews, approves or rejects payroll and salary changes. Cannot prepare or calculate.',
    scope: 'tenant',
    requiresMfa: true,
    permissions: [
      'tenant.read', 'branch.read', 'org.read', 'employee.read',
      'salary_structure.read', 'salary.read_assignment', 'salary.approve_assignment',
      'employee.verify_bank', 'employee.read_bank', 'employee.read_identifiers',
      'payroll.read', 'payroll.approve', 'payroll.finalize', 'payroll.approve_adjustment', 'payroll.activate',
      'payslip.read_any', 'report.read', 'audit.read',
      ...SELF_SERVICE,
    ],
  },
  store_manager: {
    name: 'Store Manager',
    description: 'Manages the people in assigned branches: attendance, leave and corrections.',
    scope: 'branches',
    requiresMfa: false,
    permissions: [
      'tenant.read', 'branch.read', 'employee.read', 'onboarding.read',
      'attendance.read', 'attendance.mark', 'attendance.correct', 'attendance.approve_correction',
      'leave.read_team', 'leave.approve', 'leave.reject',
      'report.read', 'export.create',
      ...SELF_SERVICE,
    ],
  },
  department_manager: {
    name: 'Department Manager',
    description: "Reviews the direct and indirect reports' requests and team reports.",
    scope: 'team',
    requiresMfa: false,
    permissions: [
      'tenant.read', 'employee.read', 'attendance.read', 'attendance.approve_correction',
      'leave.read_team', 'leave.approve', 'leave.reject', 'report.read',
      ...SELF_SERVICE,
    ],
  },
  employee: {
    name: 'Employee',
    description: 'Self-service only: own profile, attendance, leave and payslips.',
    scope: 'self',
    requiresMfa: false,
    permissions: [...SELF_SERVICE],
  },
  auditor: {
    name: 'Auditor / Read-only',
    description: 'Read-only access to explicitly authorised records and audit history. Never changes anything.',
    scope: 'tenant',
    requiresMfa: true,
    permissions: [
      'tenant.read', 'branch.read', 'org.read', 'employee.read', 'attendance.read', 'leave.read_all',
      'payroll.read', 'report.read', 'audit.read', 'user.read', 'role.read', 'invoice.read',
      'profile.read_own', 'audit.read_own',
    ],
  },
};

export const ROLE_KEYS = Object.keys(ROLES) as RoleKey[];

export function permissionsForRoles(roleKeys: readonly RoleKey[]): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const r of roleKeys) for (const p of ROLES[r].permissions) out.add(p);
  return out;
}

/** Permissions that nobody gets implicitly. Used by tests and the role-editor UI. */
export const EXPLICIT_GRANT_ONLY: readonly PermissionKey[] = PERMISSION_KEYS.filter((k) => k.startsWith('payroll.') && k !== 'payroll.read');
