'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { CommandPalette } from './palette';
import type { NavGroup, QuickAction } from '@/lib/nav-items';

type Theme = 'light' | 'dark' | 'system';
const initials = (s: string) => (s.split('@')[0] ?? s).split(/[._\s-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

function useTheme() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => { try { const t = localStorage.getItem('ht_theme'); if (t === 'light' || t === 'dark') setTheme(t); } catch { /* storage blocked: stay on system */ } }, []);
  const apply = useCallback((t: Theme) => {
    setTheme(t);
    try { if (t === 'system') localStorage.removeItem('ht_theme'); else localStorage.setItem('ht_theme', t); } catch { /* ignore */ }
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  }, []);
  const dark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  return { theme, dark, toggle: () => apply(dark ? 'light' : 'dark') };
}

export function AppShell({ groups, actions, unread, email, companies, tenantId, switchCompany, children }: {
  groups: NavGroup[]; actions: QuickAction[]; unread: number; email: string; companies: Array<{ id: string; name: string }>; tenantId: string;
  switchCompany: (fd: FormData) => Promise<void>; children: ReactNode;
}) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const { toggle, dark } = useTheme();
  useEffect(() => { try { setCollapsed(localStorage.getItem('ht_side') === '1'); } catch { /* ignore */ } }, []);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v); }
      else if (e.key === '/' && !typing) { e.preventDefault(); setPalette(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const flip = () => setCollapsed((c) => { try { localStorage.setItem('ht_side', c ? '0' : '1'); } catch { /* ignore */ } return !c; });

  const active = (href: string) => (href === '/dashboard' ? path === href : path === href || (path.startsWith(`${href}/`) && !groups.some((g) => g.items.some((i) => i.href !== href && i.href.startsWith(`${href}/`) && path.startsWith(i.href)))));
  const here = groups.flatMap((g) => g.items.map((i) => ({ g: g.title, i }))).find((x) => active(x.i.href));
  const company = companies.find((c) => c.id === tenantId)?.name ?? '';

  return (
    <div className="shell" data-collapsed={collapsed} data-open={open}>
      <a className="skip" href="#main">Skip to content</a>
      <aside className="side" aria-label="Sidebar">
        <div className="side-head">
          <div className="logo" aria-hidden="true">h</div>
          <div className="brand">human<span>Tech</span></div>
        </div>
        <nav className="side-nav" aria-label="Main">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="group">{g.title}</div>
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} data-label={i.label} aria-current={active(i.href) ? 'page' : undefined} title={collapsed ? i.label : undefined}>
                  <Icon name={i.icon} /><span className="label">{i.label}</span>
                  {i.href === '/notifications' && unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <button type="button" className="collapse-btn" onClick={flip} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Icon name="chevronLeft" /><span className="label">Collapse</span></button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="content">
        <header className="top">
          <button type="button" className="iconbtn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <div className="crumb">{company && <><span>{company}</span><span className="sep">/</span></>}<span>{here ? here.i.label : 'humanTech'}</span></div>
          <div className="spacer" />
          <button type="button" className="searchbtn" onClick={() => setPalette(true)} aria-label="Search or jump to a page">
            <Icon name="search" /><span className="label">Search or jump to…</span><kbd>⌘K</kbd>
          </button>
          <button type="button" className="iconbtn" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title="Toggle theme"><Icon name={dark ? 'sun' : 'moon'} /></button>
          {groups.some((g) => g.items.some((i) => i.href === '/notifications')) && (
            <Link className="iconbtn" href="/notifications" aria-label={unread ? `${unread} unread notifications` : 'Notifications'}><Icon name="bell" />{unread > 0 && <span className="dot">{unread > 9 ? '9+' : unread}</span>}</Link>
          )}
          <details className="menu">
            <summary className="userbtn" aria-label="Account menu"><span className="avatar sm">{initials(email)}</span><span className="label muted" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{email.split('@')[0]}</span><Icon name="chevronDown" size={14} /></summary>
            <div className="menu-panel">
              <div className="who"><strong>{email}</strong><span className="muted">{company}</span></div>
              {companies.length > 1 && (
                <form action={switchCompany}>
                  <label>Switch company<select name="company" defaultValue={tenantId}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                  <button className="btn sm" style={{ width: '100%', marginBottom: 8 }}>Switch</button>
                </form>
              )}
              <Link className="menu-item" href="/me"><Icon name="user" />My profile</Link>
              <form action="/auth/logout" method="post"><button className="menu-item" style={{ color: 'var(--danger)' }}><Icon name="logout" />Sign out</button></form>
            </div>
          </details>
        </header>
        <main className="main" id="main" tabIndex={-1}>{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} groups={groups} actions={actions} />
    </div>
  );
}
