import Link from 'next/link';
import { Icon } from '@/components/icons';
import { PLANS, planByCode } from '@/lib/plans';
import { missingConfig } from '@/lib/config';
import type { PageProps } from '@/lib/data';
import { requestCompany } from './actions';

export const metadata = { title: 'Get started' };
export const dynamic = 'force-dynamic';

export default async function Signup({ searchParams }: PageProps) {
  const sp = await searchParams;
  const done = planByCode(sp.done);
  if (done) {
    return (
      <section className="site-sec"><div className="site-wrap" style={{ maxWidth: 640 }}>
        <div className="card" style={{ textAlign: 'center', padding: 36 }}>
          <span className="stat-ico ok" style={{ margin: '0 auto 14px' }}><Icon name="check" size={24} /></span>
          <h1>Request received</h1>
          <p className="muted">Thank you. You chose <strong>{done.name}</strong>. Here is what happens next:</p>
          <ol className="steps">
            <li>We e-mail you a secure payment link for the {done.name} plan{done.code === 'customize' ? ' after a short call about what you need' : ''}.</li>
            <li>Once payment is confirmed we create your company.</li>
            <li>You get an invitation by e-mail, sign in, and invite your team.</li>
          </ol>
          <Link className="btn" href="/">Back to home</Link>
        </div>
      </div></section>
    );
  }
  const chosen = planByCode(sp.plan) ?? PLANS[0]!;
  const offline = missingConfig().includes('API_URL');
  return (
    <section className="site-sec"><div className="site-wrap signup-grid">
      <div>
        <h1>Get started with humanTech</h1>
        <p className="muted">Tell us about your company. We will send a secure payment link, then set up your company and invite you.</p>
        <ul className="plan-feat" style={{ marginTop: 18 }}>
          <li><Icon name="check" size={16} />No sign-in needed to request</li><li><Icon name="check" size={16} />Your company is created once payment is confirmed</li><li><Icon name="check" size={16} />Switch plans later</li>
        </ul>
        <p className="muted" style={{ marginTop: 18 }}>Already have an account? <Link href="/login">Sign in</Link></p>
      </div>
      <form action={requestCompany} className="card form">
        {sp.error && <p className="flash err" role="alert">{sp.error}</p>}
        {offline && <p className="flash" role="alert" style={{ background: 'var(--warn-soft)' }}>This deployment is missing <code>API_URL</code>, so requests cannot be sent yet.</p>}
        <label>Plan
          <select name="planCode" defaultValue={chosen.code}>{PLANS.map((p) => <option key={p.code} value={p.code}>{p.name}{p.price ? ` — ${p.price} / month` : ' — custom quote'}</option>)}</select>
        </label>
        <label>Company name *<input name="companyName" required minLength={2} maxLength={200} autoComplete="organization" /></label>
        <div className="grid2" style={{ gap: 12 }}>
          <label>Your name *<input name="contactName" required minLength={2} maxLength={120} autoComplete="name" /></label>
          <label>Work e-mail *<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
        </div>
        <div className="grid2" style={{ gap: 12 }}>
          <label>Phone<input name="phone" type="tel" maxLength={32} autoComplete="tel" /></label>
          <label>Number of employees<input name="employeeCount" type="number" min={1} max={1000000} /></label>
        </div>
        <label>Anything we should know?<textarea name="message" rows={3} maxLength={1000} /></label>
        <div aria-hidden="true" style={{ position: 'absolute', left: -9999 }}><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        <button className="btn primary lg" style={{ width: '100%', justifyContent: 'center' }} disabled={offline}>Request my company</button>
        <p className="muted" style={{ fontSize: 12.5 }}>By continuing you agree to be contacted about your request.</p>
      </form>
    </div></section>
  );
}
