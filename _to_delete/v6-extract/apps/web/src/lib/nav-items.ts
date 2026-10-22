import type { IconName } from '@/components/icons';

export interface NavItem { href: string; label: string; icon: IconName; any: string[]; hint?: string }
export interface NavGroup { title: string; items: NavItem[] }

/** The whole menu. `any` lists the permissions that make an entry visible (empty = everyone). The API still decides what each page may show. */
export const NAV_GROUPS: NavGroup[] = [
  { title: 'Me', items: [
    { href: '/dashboard', label: 'Home', icon: 'home', any: [] },
    { href: '/me', label: 'My profile', icon: 'user', any: ['profile.read_own'] },
    { href: '/leave', label: 'Leave', icon: 'calendar', any: ['leave.request', 'leave.read_own', 'leave.read_team', 'leave.read_all'], hint: 'Apply, approve, balances' },
    { href: '/attendance', label: 'Attendance', icon: 'clock', any: ['attendance.checkin_own', 'attendance.read_own', 'attendance.read', 'attendance.mark'], hint: 'Check in, corrections, team' },
    { href: '/payslips', label: 'My payslips', icon: 'receipt', any: ['payslip.read_own'] },
    { href: '/notifications', label: 'Notifications', icon: 'bell', any: ['profile.read_own'] },
  ] },
  { title: 'People', items: [
    { href: '/employees', label: 'Employees', icon: 'users', any: ['employee.read'], hint: 'Directory and records' },
    { href: '/onboarding', label: 'Onboarding', icon: 'clipboard', any: ['onboarding.read', 'onboarding.manage'] },
    { href: '/profile-changes', label: 'Profile changes', icon: 'edit', any: ['profile.review_change'] },
    { href: '/recruitment', label: 'Recruitment', icon: 'briefcase', any: ['candidate.read', 'recruitment.manage'], hint: 'Candidates, jobs, clients' },
  ] },
  { title: 'Pay', items: [
    { href: '/compensation', label: 'Compensation', icon: 'layers', any: ['salary_structure.read', 'salary.read_assignment', 'salary.approve_assignment'], hint: 'Components, structures, salaries' },
    { href: '/payroll', label: 'Payroll', icon: 'rupee', any: ['payroll.read', 'payroll.manage_settings'], hint: 'Pay runs and adjustments' },
  ] },
  { title: 'Company', items: [
    { href: '/org', label: 'Organisation', icon: 'building', any: ['org.read', 'branch.read'], hint: 'Branches, departments, holidays' },
    { href: '/access', label: 'Users & roles', icon: 'shield', any: ['user.read', 'role.read'], hint: 'Invitations and access' },
    { href: '/leave/admin', label: 'Leave policy', icon: 'sliders', any: ['leave.manage_policy'] },
    { href: '/attendance/admin', label: 'Attendance policy', icon: 'sliders', any: ['attendance.manage_policy'] },
    { href: '/settings', label: 'Settings', icon: 'settings', any: ['custom_field.manage', 'privacy.manage'] },
  ] },
  { title: 'Data', items: [
    { href: '/reports', label: 'Reports & exports', icon: 'chart', any: ['report.read', 'candidate.read', 'export.create'] },
    { href: '/imports', label: 'Imports', icon: 'upload', any: ['import.create', 'import.commit'], hint: 'Bring in a CSV' },
    { href: '/audit', label: 'Audit log', icon: 'history', any: ['audit.read'] },
    { href: '/privacy', label: 'Privacy requests', icon: 'lock', any: ['privacy.manage', 'profile.read_own'] },
    { href: '/billing', label: 'Plan & billing', icon: 'card', any: ['subscription.read'] },
  ] },
];

/** Things people do often, offered in the command palette and on the home screen. */
export interface QuickAction { href: string; label: string; icon: IconName; any: string[] }
export const QUICK_ACTIONS: QuickAction[] = [
  { href: '/employees/new', label: 'Add an employee', icon: 'plus', any: ['employee.create'] },
  { href: '/leave', label: 'Apply for leave', icon: 'calendar', any: ['leave.request'] },
  { href: '/attendance', label: 'Check in / out', icon: 'clock', any: ['attendance.checkin_own'] },
  { href: '/payroll', label: 'Open payroll', icon: 'rupee', any: ['payroll.read'] },
  { href: '/recruitment', label: 'Candidates', icon: 'briefcase', any: ['candidate.read'] },
  { href: '/imports', label: 'Import people', icon: 'upload', any: ['import.create'] },
  { href: '/payslips', label: 'My payslips', icon: 'receipt', any: ['payslip.read_own'] },
  { href: '/reports', label: 'Reports', icon: 'chart', any: ['report.read'] },
];

export function visibleGroups(perms: string[]): NavGroup[] {
  const have = new Set(perms);
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.any.length === 0 || i.any.some((p) => have.has(p))) })).filter((g) => g.items.length > 0);
}
export function visibleActions(perms: string[]): QuickAction[] {
  const have = new Set(perms);
  return QUICK_ACTIONS.filter((a) => a.any.some((p) => have.has(p)));
}
