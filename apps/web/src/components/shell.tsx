'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
  // The device's own preference is read after the page loads (never while rendering), so the server and the browser
  // always draw the same first frame; it is then kept in step if the person changes their device setting.
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const sync = () => setSystemDark(mq.matches);
    sync(); mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
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
  const menu = useRef<HTMLDetailsElement>(null);
  const [mac, setMac] = useState(true);
  useEffect(() => { setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)); }, []);
  // The account menu behaves like a menu: it closes when you click elsewhere, press Escape or move to another page.
  useEffect(() => {
    const shut = (e: Event) => { const m = menu.current; if (m?.open && (e.type === 'keydown' ? (e as KeyboardEvent).key === 'Escape' : !m.contains(e.target as Node))) m.open = false; };
    document.addEventListener('click', shut); document.addEventListener('keydown', shut);
    return () => { document.removeEventListener('click', shut); document.removeEventListener('keydown', shut); };
  }, []);
  useEffect(() => { if (menu.current) menu.current.open = false; }, [path]);
  // On a phone the menu is a drawer over the page: stop the page behind it from scrolling.
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [open]);
  useEffect(() => { try { setCollapsed(localStorage.getItem('ht_side') === '1'); } catch { /* ignore */ } }, []);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
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
          <Link href="/dashboard" aria-label="humanTech home" title={collapsed ? 'Home' : undefined}>
            <span className="logo" aria-hidden="true">h</span>
            <span className="brand">human<span>Tech</span>{company && <small className="side-co">{company}</small>}</span>
          </Link>
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
          <button type="button" className="collapse-btn" onClick={flip} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Icon name="chevronLeft" /><span className="label">Collapse menu</span></button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <div className="content">
        <header className="top">
          <button type="button" className="iconbtn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <nav className="crumb" aria-label="You are here">
            {here ? <><span className="co">{here.g}</span><span className="sep">/</span>{path === here.i.href ? <span aria-current="page">{here.i.label}</span> : <><Link href={here.i.href}>{here.i.label}</Link><span className="sep">/</span><span aria-current="page">Details</span></>}</> : <span>{company || 'humanTech'}</span>}
          </nav>
          <div className="spacer" />
          <button type="button" className="searchbtn" onClick={() => setPalette(true)} aria-label="Search or jump to a page">
            <Icon name="search" /><span className="label">Search people and pages…</span><kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <button type="button" className="iconbtn" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title={dark ? 'Switch to light theme' : 'Switch to dark theme'}><Icon name={dark ? 'sun' : 'moon'} /></button>
          {groups.some((g) => g.items.some((i) => i.href === '/notifications')) && (
            <Link className="iconbtn" href="/notifications" title="Notifications" aria-label={unread ? `${unread} unread notifications` : 'Notifications'}><Icon name="bell" />{unread > 0 && <span className="dot">{unread > 9 ? '9+' : unread}</span>}</Link>
          )}
          <details className="menu" ref={menu}>
            <summary className="userbtn" aria-label="Account menu" title="Your account"><span className="avatar sm">{initials(email)}</span><span className="label muted" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{email.split('@')[0]}</span><Icon name="chevronDown" size={14} /></summary>
            <div className="menu-panel">
              <div className="who"><span className="avatar">{initials(email)}</span><div><strong>{email}</strong><span className="muted">Signed in to {company || 'humanTech'}</span></div></div>
              {companies.length > 1 && (
                <form action={switchCompany}>
                  <label>Work in another company<select name="company" defaultValue={tenantId}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                  <div style={{ padding: '0 8px 8px' }}><button className="btn sm block">Switch company</button></div>
                  <div className="menu-sep" />
                </form>
              )}
              {groups.some((g) => g.items.some((i) => i.href === '/me')) && <Link className="menu-item" href="/me"><Icon name="user" />My profile</Link>}
              <button type="button" className="menu-item" onClick={() => { if (menu.current) menu.current.open = false; setPalette(true); }}><Icon name="search" />Search<kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd></button>
              <button type="button" className="menu-item" onClick={toggle}><Icon name={dark ? 'sun' : 'moon'} />{dark ? 'Light theme' : 'Dark theme'}</button>
              <div className="menu-sep" />
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
