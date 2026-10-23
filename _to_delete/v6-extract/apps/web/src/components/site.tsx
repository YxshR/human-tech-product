import Link from 'next/link';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { Icon } from './icons';

/** Header for the public pages. Shows "Open app" instead of Sign in when a session already exists. */
export async function SiteHeader() {
  const signedIn = !!(await cookies()).get('ht_session');
  return (
    <header className="site-head">
      <div className="site-wrap site-head-in">
        <Link href="/" className="site-brand"><span className="logo" aria-hidden="true">h</span><span className="brand">human<span>Tech</span></span></Link>
        <nav className="site-nav" aria-label="Main">
          <Link href="/#features">Features</Link><Link href="/#how">How it works</Link><Link href="/pricing">Pricing</Link><Link href="/#faq">FAQ</Link>
        </nav>
        <div className="site-cta">
          {signedIn ? <Link className="btn primary" href="/dashboard">Open app <Icon name="arrowRight" size={16} /></Link> : <>
            <Link className="btn ghost" href="/login">Sign in</Link>
            <Link className="btn primary" href="/signup">Get started</Link>
          </>}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="site-wrap site-foot-in">
        <div><div className="site-brand"><span className="logo" aria-hidden="true">h</span><span className="brand">human<span>Tech</span></span></div>
          <p className="muted" style={{ maxWidth: 320 }}>HR, attendance, leave and payroll for growing Indian companies.</p></div>
        <div><strong>Product</strong><Link href="/#features">Features</Link><Link href="/pricing">Pricing</Link><Link href="/#faq">FAQ</Link></div>
        <div><strong>Account</strong><Link href="/login">Sign in</Link><Link href="/signup">Get started</Link></div>
      </div>
      <div className="site-wrap muted site-legal">© {new Date().getFullYear()} humanTech. All rights reserved.</div>
    </footer>
  );
}

export const Section = ({ id, title, lead, children, tone }: { id?: string; title?: string; lead?: ReactNode; children: ReactNode; tone?: 'alt' }) => (
  <section id={id} className={`site-sec ${tone ?? ''}`}><div className="site-wrap">{title && <div className="site-sec-head"><h2>{title}</h2>{lead && <p className="muted">{lead}</p>}</div>}{children}</div></section>
);

import { PLANS } from '@/lib/plans';
export function PlanCards() {
  return (
    <div className="plan-grid">
      {PLANS.map((p) => (
        <article key={p.code} className={`plan ${p.highlight ? 'hot' : ''}`}>
          {p.highlight && <span className="plan-flag">Most popular</span>}
          <h3>{p.name}</h3><p className="muted">{p.tagline}</p>
          <div className="plan-price">{p.price ? <><strong>{p.price}</strong><span> {p.per}</span></> : <strong>Let’s talk</strong>}</div>
          <ul className="plan-list"><li><Icon name="users" size={16} />{p.people}</li><li><Icon name="building" size={16} />{p.branches}</li></ul>
          <ul className="plan-feat">{p.features.map((f) => <li key={f}><Icon name="check" size={16} />{f}</li>)}</ul>
          <Link className={`btn ${p.highlight ? 'primary' : ''}`} href={`/signup?plan=${p.code}`} style={{ width: '100%', justifyContent: 'center' }}>{p.cta}</Link>
        </article>
      ))}
    </div>
  );
}

export const FAQ_ITEMS: Array<[string, string]> = [
  ['How do I get started?', 'Pick a plan and tell us about your company. We email you a secure payment link. Once payment is confirmed we create your company and send an invitation; you sign in and start adding people.'],
  ['Do I have to pay before I can sign in?', 'Yes. Companies are created after payment is confirmed, so there is no unpaid free-for-all. Customize plans start with a conversation about what you need.'],
  ['Can I change plans later?', 'Yes. Ask us and we move you up or down; your data stays exactly where it is.'],
  ['Is it built for Indian payroll?', 'Amounts are in rupees, dates and cut-offs follow India time, and statutory rules (PF, ESI, professional tax, TDS and so on) are set up as data and approved by a second person before they are used. We do not ship hidden defaults.'],
  ['How is our data protected?', 'Every company is isolated at the database level. Sensitive identifiers are encrypted, every change is recorded in an audit log, and payroll needs a second person to approve.'],
  ['Who can see what?', 'Roles and branch scope decide it. An employee sees their own record and payslips; managers see their team; HR and finance see what their role allows.'],
  ['Can employees use it on their phones?', 'Yes. The app works on phones and tablets, with light and dark themes.'],
];
export function Faq() {
  return <div className="faq">{FAQ_ITEMS.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>;
}
