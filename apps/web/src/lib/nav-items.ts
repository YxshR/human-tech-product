import type { IconName } from '@/components/icons';

export interface NavItem { href: string; label: string; icon: IconName; any: string[]; hint?: string }
export interface NavGroup { title: string; items: NavItem[] }

/** The whole menu. `any` lists the permissions that make an entry visible (empty = everyone). The API still decides what each page may show. */
export const NAV_GROUPS: NavGroup[] = [
  { title: 'Me', items: [
    { href: '/dashboard', label: 'Home', icon: 'home', any: [], hint: 'Your day at a glance' },
    { href: '/me', label: 'My profile', icon: 'user', any: ['profile.read_own'], hint: 'Your details and change requests' },
    { href: '/leave', label: 'Leave', icon: 'calendar', any: ['leave.request', 'leave.read_own', 'leave.read_team', 'leave.read_all'], hint: 'Apply, approve, balances' },
    { href: '/attendance', label: 'Attendance', icon: 'clock', any: ['attendance.checkin_own', 'attendance.read_own', 'attendance.read', 'attendance.mark'], hint: 'Check in, corrections, team' },
    { href: '/payslips', label: 'My payslips', icon: 'receipt', any: ['payslip.read_own'], hint: 'View and download payslips' },
    { href: '/notifications', label: 'Notifications', icon: 'bell', any: ['profile.read_own'], hint: 'Updates and preferences' },
  ] },
  { title: 'People', items: [
    { href: '/employees', label: 'Employees', icon: 'users', any: ['employee.read'], hint: 'Directory and records' },
    { href: '/onboarding', label: 'Onboarding', icon: 'clipboard', any: ['onboarding.read', 'onboarding.manage'], hint: 'Joining and leaving checklists' },
    { href: '/profile-changes', label: 'Profile changes', icon: 'edit', any: ['profile.review_change'], hint: 'Review employee requests' },
    { href: '/recruitment', label: 'Recruitment', icon: 'briefcase', any: ['candidate.read', 'recruitment.manage'], hint: 'Candidates, jobs, clients' },
  ] },
  { title: 'Pay', items: [
    { href: '/compensation', label: 'Compensation', icon: 'layers', any: ['salary_structure.read', 'salary.read_assignment', 'salary.approve_assignment'], hint: 'Components, structures, salaries' },
    { href: '/payroll', label: 'Payroll', icon: 'rupee', any: ['payroll.read', 'payroll.manage_settings'], hint: 'Pay runs and adjustments' },
  ] },
  { title: 'Company', items: [
    { href: '/org', label: 'Organisation', icon: 'building', any: ['org.read', 'branch.read'], hint: 'Branches, departments, holidays' },
    { href: '/access', label: 'Users & roles', icon: 'shield', any: ['user.read', 'role.read'], hint: 'Invitations and access' },
    { href: '/leave/admin', label: 'Leave policy', icon: 'sliders', any: ['leave.manage_policy'], hint: 'Leave types and rules' },
    { href: '/attendance/admin', label: 'Attendance policy', icon: 'sliders', any: ['attendance.manage_policy'], hint: 'Shifts and rules' },
    { href: '/settings', label: 'Settings', icon: 'settings', any: ['custom_field.manage', 'privacy.manage'], hint: 'Custom fields and saved views' },
  ] },
  { title: 'Data', items: [
    { href: '/reports', label: 'Reports & exports', icon: 'chart', any: ['report.read', 'candidate.read', 'export.create'], hint: 'Numbers and CSV downloads' },
    { href: '/imports', label: 'Imports', icon: 'upload', any: ['import.create', 'import.commit'], hint: 'Bring in a CSV' },
    { href: '/audit', label: 'Audit log', icon: 'history', any: ['audit.read'], hint: 'Who changed what, and when' },
    { href: '/privacy', label: 'Privacy requests', icon: 'lock', any: ['privacy.manage', 'profile.read_own'], hint: 'Data access and deletion' },
    { href: '/billing', label: 'Plan & billing', icon: 'card', any: ['subscription.read'], hint: 'Your plan, usage, invoices' },
  ] },
];

/** Things people do often, offered in the command palette and on the home screen. */
export interface QuickAction { href: string; label: string; icon: IconName; any: string[]; hint: string }
export const QUICK_ACTIONS: QuickAction[] = [
  { href: '/employees/new', label: 'Add an employee', icon: 'plus', any: ['employee.create'], hint: 'Create a new employee record' },
  { href: '/leave', label: 'Apply for leave', icon: 'calendar', any: ['leave.request'], hint: 'Request time off' },
  { href: '/attendance', label: 'Check in / out', icon: 'clock', any: ['attendance.checkin_own'], hint: 'Record today\'s attendance' },
  { href: '/payroll', label: 'Open payroll', icon: 'rupee', any: ['payroll.read'], hint: 'Pay runs and approvals' },
  { href: '/recruitment', label: 'Candidates', icon: 'briefcase', any: ['candidate.read'], hint: 'Track people you are hiring' },
  { href: '/imports', label: 'Import people', icon: 'upload', any: ['import.create'], hint: 'Bring in a list from a CSV file' },
  { href: '/payslips', label: 'My payslips', icon: 'receipt', any: ['payslip.read_own'], hint: 'View and download payslips' },
  { href: '/reports', label: 'Reports', icon: 'chart', any: ['report.read'], hint: 'Headcount, attendance, exports' },
];

export function visibleGroups(perms: string[]): NavGroup[] {
  const have = new Set(perms);
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.any.length === 0 || i.any.some((p) => have.has(p))) })).filter((g) => g.items.length > 0);
}
export function visibleActions(perms: string[]): QuickAction[] {
  const have = new Set(perms);
  return QUICK_ACTIONS.filter((a) => a.any.some((p) => have.has(p)));
}
