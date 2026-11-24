import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiFailure } from '@/lib/api';
import { PLANS, planByCode } from '@/lib/plans';
import { tenantCookie } from '@/lib/session';
import { Icon } from '@/components/icons';
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
    <main className="main">
      <div className="card" style={{ maxWidth: 880, margin: '0 auto' }}>
        <h1>Set up your company</h1>
        <p className="muted">Signed in as {me.data.email}. Choose a plan and name your company. You can change plans later.</p>
        {sp.error && <p className="flash err" role="alert">{sp.error}</p>}
        <form action={createCompany} className="form">
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ marginBottom: 8 }}>Plan</legend>
            <div className="plan-grid">
              {PLANS.map((p) => (
                <label key={p.code} className={`plan ${p.highlight ? 'hot' : ''}`} style={{ cursor: 'pointer' }}>
                  <span className="row" style={{ gap: 8, alignItems: 'center' }}><input type="radio" name="planCode" value={p.code} defaultChecked={p.code === chosen.code} required /><h3>{p.name}</h3></span>
                  <div className="plan-price">{p.price ? <><strong>{p.price}</strong><span> {p.per}</span></> : <strong>Let’s talk</strong>}</div>
                  <ul className="plan-list"><li><Icon name="users" size={16} />{p.people}</li><li><Icon name="building" size={16} />{p.branches}</li></ul>
                  <ul className="plan-feat">{p.features.slice(0, 4).map((f) => <li key={f}><Icon name="check" size={16} />{f}</li>)}</ul>
                </label>
              ))}
            </div>
          </fieldset>
          <label>Company name *<input name="companyName" required minLength={2} maxLength={200} autoComplete="organization" placeholder="Acme Traders Pvt Ltd" /></label>
          <p className="muted" style={{ fontSize: 12.5 }}>No card needed now. Pro and Customize start with a 14-day trial; we will be in touch about billing before it ends.</p>
          <button className="btn primary lg" style={{ justifyContent: 'center' }}>Create my company</button>
        </form>
        <form action="/auth/logout" method="post" style={{ marginTop: 12 }}><button className="btn ghost sm">Sign out</button></form>
      </div>
    </main>
  );
}
