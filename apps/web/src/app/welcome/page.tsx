import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiFailure } from '@/lib/api';
import { PLANS, planByCode } from '@/lib/plans';
import { tenantCookie } from '@/lib/session';
import { Icon } from '@/components/icons';
import { SubmitButton } from '@/components/submit-button';
import type { PageProps } from '@/lib/data';

export const metadata = { title: 'Set up your company' };
export const dynamic = 'force-dynamic';

async function createCompany(fd: FormData): Promise<void> {
  'use server';
  const planCode = String(fd.get('planCode') ?? 'free');
  const companyName = String(fd.get('companyName') ?? '').trim();
  const back = (error: string): never => redirect(`/welcome?plan=${encodeURIComponent(planCode)}&error=${encodeURIComponent(error)}`);
  let tenantId: string;
  try {
    tenantId = (await api<{ data: { tenantId: string } }>('/me/company', { method: 'POST', body: { planCode, companyName }, tenant: false })).data.tenantId;
  } catch (e) {
    if (e instanceof ApiFailure) {
      if (e.status === 409) redirect('/dashboard');
      if (e.status === 422) return back('Please choose a plan and enter your company name (at least 2 characters).');
      if (e.status === 429) return back('Too many attempts. Please try again in a while.');
      return back('Something went wrong on our side. Please try again.');
    }
    throw e;
  }
  (await cookies()).set(tenantCookie(tenantId));
  redirect('/dashboard?ok=Your+company+is+ready.+Welcome!');
}

/** Step 2 of sign-up: signed in with Google, now choose a plan and name the company. People who already have one go straight in. */
export default async function Welcome({ searchParams }: PageProps) {
  const sp = await searchParams;
  const me = await api<{ data: { email: string; companies: Array<{ id: string }> } }>('/me', { tenant: false });
  if (me.data.companies.length > 0) redirect('/dashboard');
  const chosen = planByCode(sp.plan) ?? PLANS[0]!;
  return (
    <div className="auth-wrap">
      <main className="card wide" id="main">
        <ol className="stepper" aria-label="Sign-up steps"><li className="done"><span className="n">✓</span>Signed in</li><li className="on" aria-current="step"><span className="n">2</span>Choose a plan and name your company</li></ol>
        <h1>Set up your company</h1>
        <p className="muted">You are signed in as <strong>{me.data.email}</strong>. You will be the company&apos;s administrator and can invite everyone else afterwards.</p>
        {sp.error && <div className="flash err" role="alert" style={{ marginTop: 14 }}><Icon name="alert" size={18} /><div><strong>Your company was not created</strong><span>{sp.error}</span></div></div>}
        <form action={createCompany} className="form" style={{ maxWidth: 'none', marginTop: 20 }}>
          <label style={{ maxWidth: 460 }}><span>Company name<span className="req" aria-hidden="true">*</span></span><input name="companyName" required minLength={2} maxLength={200} autoComplete="organization" placeholder="e.g. Acme Traders Pvt Ltd" autoFocus /><span className="hint">The name your employees will see. You can change it later.</span></label>
          <fieldset className="field">
            <legend>Plan<span className="req" aria-hidden="true">*</span></legend>
            <div className="plan-pick">
              {PLANS.map((p) => (
                <label key={p.code}>
                  <input type="radio" name="planCode" value={p.code} defaultChecked={p.code === chosen.code} required aria-label={p.name} />
                  <h3>{p.name}</h3>
                  <div className="plan-price">{p.price ? <><strong>{p.price}</strong><span> {p.per}</span></> : <strong>Tailored quote</strong>}</div>
                  <span className="muted">{p.people} · {p.branches.toLowerCase()}</span>
                  <ul>{p.features.slice(0, 4).map((f) => <li key={f}><Icon name="check" size={14} />{f}</li>)}</ul>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="callout plain" style={{ margin: 0 }}><Icon name="info" size={18} /><div><p style={{ margin: 0 }}><strong style={{ display: 'inline' }}>No card needed.</strong> Free is free for good. Pro and Customize start with a 14-day trial, and we contact you about billing before it ends. You can change plan later without losing data.</p></div></div>
          <div className="form-actions"><SubmitButton tone="primary">Create my company</SubmitButton></div>
        </form>
        <form action="/auth/logout" method="post" className="auth-foot"><span>Not {me.data.email}? <button className="btn ghost sm">Sign out</button></span></form>
      </main>
    </div>
  );
}
