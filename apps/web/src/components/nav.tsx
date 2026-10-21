'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Item { href: string; label: string; any: string[] }
const GROUPS: Array<{ title: string; items: Item[] }> = [
  { title: 'Me', items: [
    { href: '/dashboard', label: 'Home', any: [] },
    { href: '/me', label: 'My profile', any: ['profile.read_own'] },
    { href: '/leave', label: 'Leave', any: ['leave.request', 'leave.read_own', 'leave.read_team', 'leave.read_all'] },
    { href: '/attendance', label: 'Attendance', any: ['attendance.checkin_own', 'attendance.read_own', 'attendance.read', 'attendance.mark'] },
    { href: '/payslips', label: 'My payslips', any: ['payslip.read_own'] },
    { href: '/notifications', label: 'Notifications', any: ['profile.read_own'] },
  ] },
  { title: 'People', items: [
    { href: '/employees', label: 'Employees', any: ['employee.read'] },
    { href: '/onboarding', label: 'Onboarding', any: ['onboarding.read', 'onboarding.manage'] },
    { href: '/profile-changes', label: 'Profile changes', any: ['profile.review_change'] },
    { href: '/recruitment', label: 'Recruitment', any: ['candidate.read', 'recruitment.manage'] },
  ] },
  { title: 'Pay', items: [
    { href: '/compensation', label: 'Compensation', any: ['salary_structure.read', 'salary.read_assignment', 'salary.approve_assignment'] },
    { href: '/payroll', label: 'Payroll', any: ['payroll.read', 'payroll.manage_settings'] },
  ] },
  { title: 'Company', items: [
    { href: '/org', label: 'Organisation', any: ['org.read', 'branch.read'] },
    { href: '/access', label: 'Users & roles', any: ['user.read', 'role.read'] },
    { href: '/leave/admin', label: 'Leave policy', any: ['leave.manage_policy'] },
    { href: '/attendance/admin', label: 'Attendance policy', any: ['attendance.manage_policy'] },
    { href: '/settings', label: 'Settings', any: ['custom_field.manage', 'privacy.manage'] },
  ] },
  { title: 'Data', items: [
    { href: '/reports', label: 'Reports & exports', any: ['report.read', 'candidate.read', 'export.create'] },
    { href: '/imports', label: 'Imports', any: ['import.create', 'import.commit'] },
    { href: '/audit', label: 'Audit log', any: ['audit.read'] },
    { href: '/privacy', label: 'Privacy requests', any: ['privacy.manage', 'profile.read_own'] },
    { href: '/billing', label: 'Plan & billing', any: ['subscription.read'] },
  ] },
];

export function Nav({ permissions, unread }: { permissions: string[]; unread: number }) {
  const path = usePathname();
  const have = new Set(permissions);
  const active = (href: string) => (href === '/dashboard' ? path === href : path === href || (path.startsWith(`${href}/`) && !GROUPS.some((g) => g.items.some((i) => i.href !== href && i.href.startsWith(`${href}/`) && path.startsWith(i.href)))));
  return (
    <nav aria-label="Main">
      {GROUPS.map((g) => {
        const items = g.items.filter((i) => i.any.length === 0 || i.any.some((p) => have.has(p)));
        if (items.length === 0) return null;
        return (
          <div key={g.title}>
            <div className="group">{g.title}</div>
            {items.map((i) => (
              <Link key={i.href} href={i.href} aria-current={active(i.href) ? 'page' : undefined} style={{ display: 'block' }}>
                {i.label}{i.href === '/notifications' && unread > 0 && <span className="pill" style={{ marginLeft: 8 }}>{unread}</span>}
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
