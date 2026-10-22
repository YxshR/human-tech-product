'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';

interface Item { href: string; label: string; any: string[]; icon: string }
const GROUPS: Array<{ title: string; items: Item[] }> = [
  { title: 'Me', items: [
    { href: '/dashboard', label: 'Home', icon: 'home', any: [] },
    { href: '/me', label: 'My profile', icon: 'user', any: ['profile.read_own'] },
    { href: '/leave', label: 'Leave', icon: 'calendar', any: ['leave.request', 'leave.read_own', 'leave.read_team', 'leave.read_all'] },
    { href: '/attendance', label: 'Attendance', icon: 'clock', any: ['attendance.checkin_own', 'attendance.read_own', 'attendance.read', 'attendance.mark'] },
    { href: '/payslips', label: 'My payslips', icon: 'receipt', any: ['payslip.read_own'] },
    { href: '/notifications', label: 'Notifications', icon: 'bell', any: ['profile.read_own'] },
  ] },
  { title: 'People', items: [
    { href: '/employees', label: 'Employees', icon: 'users', any: ['employee.read'] },
    { href: '/onboarding', label: 'Onboarding', icon: 'rocket', any: ['onboarding.read', 'onboarding.manage'] },
    { href: '/profile-changes', label: 'Profile changes', icon: 'edit', any: ['profile.review_change'] },
    { href: '/recruitment', label: 'Recruitment', icon: 'briefcase', any: ['candidate.read', 'recruitment.manage'] },
  ] },
  { title: 'Pay', items: [
    { href: '/compensation', label: 'Compensation', icon: 'wallet', any: ['salary_structure.read', 'salary.read_assignment', 'salary.approve_assignment'] },
    { href: '/payroll', label: 'Payroll', icon: 'banknote', any: ['payroll.read', 'payroll.manage_settings'] },
  ] },
  { title: 'Company', items: [
    { href: '/org', label: 'Organisation', icon: 'building', any: ['org.read', 'branch.read'] },
    { href: '/access', label: 'Users & roles', icon: 'shield', any: ['user.read', 'role.read'] },
    { href: '/leave/admin', label: 'Leave policy', icon: 'leaf', any: ['leave.manage_policy'] },
    { href: '/attendance/admin', label: 'Attendance policy', icon: 'fingerprint', any: ['attendance.manage_policy'] },
    { href: '/settings', label: 'Settings', icon: 'cog', any: ['custom_field.manage', 'privacy.manage'] },
  ] },
  { title: 'Data', items: [
    { href: '/reports', label: 'Reports & exports', icon: 'chart', any: ['report.read', 'candidate.read', 'export.create'] },
    { href: '/imports', label: 'Imports', icon: 'upload', any: ['import.create', 'import.commit'] },
    { href: '/audit', label: 'Audit log', icon: 'scroll', any: ['audit.read'] },
    { href: '/privacy', label: 'Privacy requests', icon: 'lock', any: ['privacy.manage', 'profile.read_own'] },
    { href: '/billing', label: 'Plan & billing', icon: 'card', any: ['subscription.read'] },
  ] },
];

export function crumbFor(path: string): [group: string, label: string] {
  let best: [string, string] = ['', ''];
  let len = -1;
  for (const g of GROUPS) for (const i of g.items) if ((path === i.href || path.startsWith(`${i.href}/`)) && i.href.length > len) { best = [g.title, i.label]; len = i.href.length; }
  return best;
}

const KEY = 'ht-nav-closed';

export function Nav({ permissions, unread }: { permissions: string[]; unread: number }) {
  const path = usePathname();
  const have = new Set(permissions);
  const [closed, setClosed] = useState<string[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => { try { setClosed(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]); } catch { /* ignore corrupt value */ } }, []);
  const toggle = (title: string) => setClosed((c) => {
    const next = c.includes(title) ? c.filter((t) => t !== title) : [...c, title];
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* not persisted */ }
    return next;
  });
  const active = (href: string) => (href === '/dashboard' ? path === href : path === href || (path.startsWith(`${href}/`) && !GROUPS.some((g) => g.items.some((i) => i.href !== href && i.href.startsWith(`${href}/`) && path.startsWith(i.href)))));
  const needle = q.trim().toLowerCase();
  let shown = 0;
  return (
    <>
      <div className="nav-filter" role="search">
        <span className="search-ico"><Icon name="search" size={16} /></span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a page…" aria-label="Find a page" />
      </div>
      <nav aria-label="Main">
        {GROUPS.map((g) => {
          const allowed = g.items.filter((i) => i.any.length === 0 || i.any.some((p) => have.has(p)));
          const items = needle ? allowed.filter((i) => i.label.toLowerCase().includes(needle)) : allowed;
          if (items.length === 0) return null;
          shown += items.length;
          const isClosed = !needle && closed.includes(g.title) && !allowed.some((i) => active(i.href));
          return (
            <div key={g.title} className={`nav-group${isClosed ? ' closed' : ''}`}>
              <button type="button" className="group" onClick={() => toggle(g.title)} aria-expanded={!isClosed}>{g.title}<Icon name="chevron" /></button>
              <div className="group-items">
                {items.map((i) => (
                  <Link key={i.href} href={i.href} title={i.label} className="nav-link" aria-current={active(i.href) ? 'page' : undefined}>
                    <Icon name={i.icon} /><span className="nav-text">{i.label}</span>{i.href === '/notifications' && unread > 0 && <span className="nav-badge">{unread}</span>}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
        {needle && shown === 0 && <p className="nav-empty">No pages match &ldquo;{q}&rdquo;.</p>}
      </nav>
    </>
  );
}
