import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Icon, type IconName } from '@/components/icons';
import { Faq, PlanCards, Section } from '@/components/site';

export const dynamic = 'force-dynamic';
export const metadata = { title: { absolute: 'humanTech — HR, attendance, leave and payroll for Indian companies' }, description: 'One place for people records, attendance, leave, payroll and hiring. Built for growing Indian companies.' };

const FEATURES: Array<[IconName, string, string]> = [
  ['users', 'People records', 'One profile per employee: documents, bank and ID details, history, branches, departments and managers.'],
  ['clock', 'Attendance', 'Check in and out, corrections with approval, team views, and a payroll lock so numbers never change after cut-off.'],
  ['calendar', 'Leave', 'Leave types, balances, holidays, half-days and approvals by the right manager.'],
  ['rupee', 'Payroll', 'Salary structures, monthly runs, payslips as PDF, and a second person approves before anything is paid.'],
  ['briefcase', 'Recruitment', 'Candidates, stages, follow-ups and client tracking, then convert a hire into an employee in one click.'],
  ['clipboard', 'Onboarding & exit', 'Checklists with owners and due dates for joiners and leavers, so nothing is forgotten.'],
  ['chart', 'Reports & imports', 'Export what you need as CSV, and bring in your existing people with a guided CSV import.'],
  ['shield', 'Roles & audit', 'Access by role and branch, sensitive fields masked, and a full history of who changed what.'],
];
const HOW: Array<[string, string, string]> = [
  ['1', 'Choose a plan', 'Pick Plus, Pro or Customize and tell us about your company.'],
  ['2', 'We confirm payment', 'You get a secure payment link by e-mail. We create your company once it is paid.'],
  ['3', 'Sign in and go', 'You receive an invitation, sign in, and invite your team with the right roles.'],
];

export default async function Home() {
  if ((await cookies()).get('ht_session')) redirect('/dashboard');
  return (
    <>
      <section className="site-hero">
        <div className="site-wrap hero-grid">
          <div>
            <span className="site-pill">Built for Indian companies</span>
            <h1>People operations,<br />without the spreadsheets.</h1>
            <p className="lead">humanTech brings employee records, attendance, leave, payroll and hiring into one clear, secure place, so your team spends time on people, not paperwork.</p>
            <div className="row" style={{ gap: 12, marginTop: 24 }}>
              <Link className="btn primary lg" href="/signup">Get started <Icon name="arrowRight" size={16} /></Link>
              <Link className="btn lg" href="/pricing">See plans &amp; pricing</Link>
            </div>
            <ul className="hero-points"><li><Icon name="check" size={16} />Rupees, India time, statutory-ready</li><li><Icon name="check" size={16} />Every company isolated and audited</li><li><Icon name="check" size={16} />Works on phone and desktop</li></ul>
          </div>
          <div className="mock" aria-hidden="true">
            <div className="mock-bar"><i /><i /><i /></div>
            <div className="mock-body">
              <div className="mock-side">{['Home', 'Leave', 'Attendance', 'Employees', 'Payroll', 'Reports'].map((x, i) => <span key={x} className={i === 0 ? 'on' : ''}>{x}</span>)}</div>
              <div className="mock-main">
                <div className="mock-hero">Good morning, Priya</div>
                <div className="mock-stats"><div><b>248</b><small>Active employees</small></div><div><b>96%</b><small>Present today</small></div><div><b>12</b><small>Leave requests</small></div></div>
                <div className="mock-rows"><span /><span /><span /><span /></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Section id="features" title="Everything your people team does, in one place" lead="Start with the basics and switch on more as you grow.">
        <div className="feat-grid">{FEATURES.map(([icon, t, d]) => <article key={t} className="feat"><span className="stat-ico"><Icon name={icon} size={22} /></span><h3>{t}</h3><p className="muted">{d}</p></article>)}</div>
      </Section>

      <Section id="how" title="From sign-up to first payslip" lead="No long projects. We set you up." tone="alt">
        <div className="how-grid">{HOW.map(([n, t, d]) => <article key={n} className="how"><span className="how-n">{n}</span><h3>{t}</h3><p className="muted">{d}</p></article>)}</div>
      </Section>

      <Section title="Made for how Indian companies work">
        <div className="feat-grid three">
          <article className="feat"><span className="stat-ico ok"><Icon name="rupee" size={22} /></span><h3>Statutory-ready payroll</h3><p className="muted">PF, ESI, professional tax and TDS rules are set up as data and approved by a second person, so you stay in control of what is applied.</p></article>
          <article className="feat"><span className="stat-ico info"><Icon name="lock" size={22} /></span><h3>Security you can explain</h3><p className="muted">Company data is isolated in the database, sensitive identifiers are encrypted, and every change is logged.</p></article>
          <article className="feat"><span className="stat-ico warn"><Icon name="sparkle" size={22} /></span><h3>Easy for everyone</h3><p className="muted">Employees get a simple home screen, search with one keystroke, light and dark themes, and a mobile-friendly layout.</p></article>
        </div>
      </Section>

      <Section id="pricing" title="Simple plans" lead="Pick the one that fits your size. Move up any time." tone="alt">
        <PlanCards />
        <p className="muted" style={{ textAlign: 'center', marginTop: 18 }}>Prices in INR, billed monthly. <Link href="/pricing">Compare plans in detail →</Link></p>
      </Section>

      <Section id="faq" title="Questions, answered"><Faq /></Section>

      <section className="site-final"><div className="site-wrap"><h2>Ready to bring your people team together?</h2><p>Choose a plan and we will have you up and running.</p>
        <div className="row" style={{ justifyContent: 'center', gap: 12 }}><Link className="btn primary lg" href="/signup">Get started</Link><Link className="btn lg" href="/login">I already have an account</Link></div></div></section>
    </>
  );
}
