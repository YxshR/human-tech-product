'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';
import { crumbFor } from './nav';
import { Appearance, SidebarToggle } from './appearance';

/** Sticky top bar: menu toggle (mobile), breadcrumb, notifications and the account menu. */
export function Header({ company, email, unread }: { company: string; email: string; unread: number }) {
  const path = usePathname();
  const [group, label] = crumbFor(path);
  useEffect(() => {
    const closeAll = (except?: Element | null) => document.querySelectorAll<HTMLDetailsElement>('details.menu[open]').forEach((d) => { if (d !== except) d.open = false; });
    const onClick = (e: MouseEvent) => closeAll((e.target as Element | null)?.closest('details.menu'));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll(); };
    document.addEventListener('click', onClick); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); };
  }, []);
  return (
    <header className="header">
      <label htmlFor="navtoggle" className="menu-btn" aria-label="Open navigation"><Icon name="menu" /></label>
      <SidebarToggle />
      <nav className="crumbs" aria-label="Breadcrumb">
        <span className="crumb-co">{company}</span>
        {group && <><span className="crumb-sep" aria-hidden="true">/</span><span>{group}</span></>}
        {label && <><span className="crumb-sep" aria-hidden="true">/</span><strong>{label}</strong></>}
      </nav>
      <div className="header-end">
        <Appearance />
        <Link href="/notifications" className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Icon name="bell" />{unread > 0 && <span className="icon-dot">{unread > 9 ? '9+' : unread}</span>}
        </Link>
        <details className="menu">
          <summary aria-label="Account menu"><span className="avatar sm" aria-hidden="true">{email.slice(0, 2)}</span></summary>
          <div className="menu-pop">
            <div className="menu-who"><span className="avatar" aria-hidden="true">{email.slice(0, 2)}</span><div><strong>{email.split('@')[0]}</strong><div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{email}</div></div></div>
            <Link href="/me" className="menu-item"><Icon name="user" />My profile</Link>
            <form action="/auth/logout" method="post"><button className="menu-item danger"><Icon name="logout" />Sign out</button></form>
          </div>
        </details>
      </div>
    </header>
  );
}
