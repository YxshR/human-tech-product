/**
 * Single source of truth for every permission in the product.
 * The database `permissions` table is seeded from this file and a test asserts they match.
 *
 * Naming: `<domain>.<action>` (lowercase, underscores). Sensitivity drives extra controls:
 *   normal    - ordinary business data
 *   sensitive - personal / compensation / financial data: access is audited, export is gated
 *   critical  - actions that move money or change security posture: MFA + maker-checker where relevant
 */
export type Sensitivity = 'normal' | 'sensitive' | 'critical';

interface PermissionDef {
  description: string;
  sensitivity?: Sensitivity;
}

function defs<T extends Record<string, PermissionDef>>(d: T): T {
  return d;
}

export const PERMISSIONS = defs({
  // --- Tenant & access ---
  'tenant.read': { description: 'View company profile and settings' },
  'tenant.update': { description: 'Edit company profile', sensitivity: 'sensitive' },
  'settings.manage': { description: 'Manage company settings (calendars, templates, preferences)' },
  'user.read': { description: 'View users and invitations of the company' },
  'user.invite': { description: 'Invite users to the company', sensitivity: 'sensitive' },
  'user.manage': { description: 'Suspend/restore company memberships', sensitivity: 'critical' },
  'role.read': { description: 'View roles and their permissions' },
  'role.manage': { description: 'Create roles and grant permissions/branch scope', sensitivity: 'critical' },
  'support.grant_access': { description: 'Approve time-limited platform support access', sensitivity: 'critical' },

  // --- Organisation ---
  'branch.read': { description: 'View branches/stores' },
  'branch.create': { description: 'Create branches' },
  'branch.update': { description: 'Edit/archive branches' },
  'branch.assign_manager': { description: 'Assign branch managers' },
  'org.read': { description: 'View departments, designations, cost centres' },
  'org.manage': { description: 'Manage departments, designations, cost centres, holidays' },

  // --- Employees ---
  'employee.read': { description: 'View employee records within scope' },
  'employee.create': { description: 'Create employees' },
  'employee.update': { description: 'Edit employee records' },
  'employee.archive': { description: 'Archive employees' },
  'employee.exit': { description: 'Start and complete offboarding', sensitivity: 'sensitive' },
  'employee.read_sensitive': { description: 'View DOB, address and other personal details', sensitivity: 'sensitive' },
  'employee.update_sensitive': { description: 'Edit personal details', sensitivity: 'sensitive' },
  'employee.read_identifiers': { description: 'View masked statutory identifiers (PAN/UAN/ESIC)', sensitivity: 'sensitive' },
  'employee.read_bank': { description: 'View masked bank details', sensitivity: 'sensitive' },
  'employee.update_bank': { description: 'Enter or change bank details', sensitivity: 'critical' },
  'employee.verify_bank': { description: 'Verify bank details entered by someone else', sensitivity: 'critical' },
  'employee.export': { description: 'Export employee data', sensitivity: 'sensitive' },
  'onboarding.read': { description: 'View onboarding tasks' },
  'onboarding.manage': { description: 'Assign and complete onboarding/offboarding tasks' },
  'document.read': { description: 'View employee documents within scope', sensitivity: 'sensitive' },
  'document.upload': { description: 'Upload employee documents' },
  'document.delete': { description: 'Delete employee documents', sensitivity: 'sensitive' },

  // --- Recruitment ---
  'candidate.read': { description: 'View candidates' },
  'candidate.create': { description: 'Create candidates' },
  'candidate.update': { description: 'Edit candidates' },
  'candidate.change_stage': { description: 'Move candidates through the pipeline' },
  'candidate.read_salary': { description: 'View candidate current/expected salary', sensitivity: 'sensitive' },
  'candidate.convert': { description: 'Convert a selected candidate into an employee' },
  'candidate.export': { description: 'Export candidates', sensitivity: 'sensitive' },
  'recruitment.manage': { description: 'Manage clients and job requirements' },

  // --- Attendance ---
  'attendance.read': { description: 'View attendance within scope' },
  'attendance.mark': { description: 'Mark/edit attendance' },
  'attendance.correct': { description: 'Request corrections on behalf of others' },
  'attendance.approve_correction': { description: 'Approve attendance corrections' },
  'attendance.lock': { description: 'Lock attendance for payroll cutoff', sensitivity: 'critical' },
  'attendance.manage_policy': { description: 'Manage shifts and attendance policies' },
  'attendance.read_own': { description: 'View own attendance' },
  'attendance.checkin_own': { description: 'Check in/out when enabled' },
  'attendance.request_correction_own': { description: 'Request correction of own attendance' },

  // --- Leave ---
  'leave.read_team': { description: 'View leave of own team' },
  'leave.read_all': { description: 'View leave across the scope' },
  'leave.read_own': { description: 'View own leave and balances' },
  'leave.request': { description: 'Apply for own leave' },
  'leave.approve': { description: 'Approve leave within scope' },
  'leave.reject': { description: 'Reject leave within scope' },
  'leave.adjust_balance': { description: 'Manually adjust leave balances', sensitivity: 'sensitive' },
  'leave.manage_policy': { description: 'Manage leave types and policies' },

  // --- Compensation ---
  'salary_structure.read': { description: 'View salary structures/components', sensitivity: 'sensitive' },
  'salary_structure.manage': { description: 'Create/version salary structures and components', sensitivity: 'critical' },
  'salary.read_assignment': { description: 'View employee salary assignments', sensitivity: 'sensitive' },
  'salary.assign': { description: 'Propose salary assignments/revisions', sensitivity: 'critical' },
  'salary.approve_assignment': { description: 'Approve salary assignments proposed by others', sensitivity: 'critical' },

  // --- Payroll ---
  'payroll.read': { description: 'View payroll runs, registers and totals', sensitivity: 'sensitive' },
  'payroll.manage_settings': { description: 'Manage pay groups, periods and payroll settings', sensitivity: 'critical' },
  'payroll.activate': { description: 'Activate payroll for the company after review', sensitivity: 'critical' },
  'payroll.create_run': { description: 'Create payroll runs', sensitivity: 'critical' },
  'payroll.calculate': { description: 'Validate and calculate payroll runs', sensitivity: 'critical' },
  'payroll.resolve_exception': { description: 'Resolve or waive payroll exceptions', sensitivity: 'critical' },
  'payroll.submit': { description: 'Submit a calculated run for review', sensitivity: 'critical' },
  'payroll.approve': { description: 'Approve or reject payroll runs (checker)', sensitivity: 'critical' },
  'payroll.finalize': { description: 'Finalise and lock approved payroll', sensitivity: 'critical' },
  'payroll.correct': { description: 'Start a controlled correction revision', sensitivity: 'critical' },
  'payroll.manage_adjustments': { description: 'Create one-off payroll adjustments', sensitivity: 'critical' },
  'payroll.approve_adjustment': { description: 'Approve adjustments created by others', sensitivity: 'critical' },
  'payroll.export': { description: 'Export payroll registers', sensitivity: 'critical' },

  // --- Payslips ---
  'payslip.read_own': { description: 'View and download own payslips' },
  'payslip.read_any': { description: 'View payslips of others within scope', sensitivity: 'critical' },
  'payslip.generate': { description: 'Generate/regenerate payslips', sensitivity: 'sensitive' },
  'payslip.revoke': { description: 'Revoke an issued payslip', sensitivity: 'critical' },

  // --- Self service ---
  'profile.read_own': { description: 'View own profile' },
  'profile.request_change': { description: 'Request changes to own profile' },
  'profile.review_change': { description: 'Review profile change requests', sensitivity: 'sensitive' },

  // --- Reports, imports, exports, audit ---
  'report.read': { description: 'Run scoped reports' },
  'view.manage_shared': { description: 'Create company-shared table views' },
  'import.create': { description: 'Upload and validate imports' },
  'import.commit': { description: 'Commit validated imports' },
  'export.create': { description: 'Create exports of data the user can already see' },
  'export.sensitive': { description: 'Include sensitive fields in exports', sensitivity: 'critical' },
  'audit.read': { description: 'View audit history within scope', sensitivity: 'sensitive' },
  'audit.read_own': { description: 'View own relevant activity' },

  // --- Configuration ---
  'custom_field.manage': { description: 'Manage custom fields' },
  'approval.manage_workflows': { description: 'Configure approval workflows' },
  'notification.manage_templates': { description: 'Manage notification preferences/templates' },
  'privacy.manage': { description: 'Handle privacy and data-subject requests', sensitivity: 'sensitive' },

  // --- Invoices & subscription (tenant side) ---
  'invoice.read': { description: 'View company invoices', sensitivity: 'sensitive' },
  'invoice.create': { description: 'Create draft invoices', sensitivity: 'sensitive' },
  'invoice.issue': { description: 'Issue invoices', sensitivity: 'critical' },
  'invoice.void': { description: 'Void issued invoices', sensitivity: 'critical' },
  'invoice.record_payment': { description: 'Record invoice payments', sensitivity: 'sensitive' },
  'subscription.read': { description: 'View plan, limits and usage' },
  'subscription.manage': { description: 'Manage plan and billing contacts', sensitivity: 'critical' },
} as const);

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export function permissionDomain(key: PermissionKey): string {
  return key.split('.')[0] as string;
}

export function sensitivityOf(key: PermissionKey): Sensitivity {
  const def = PERMISSIONS[key] as PermissionDef;
  return def.sensitivity ?? 'normal';
}
