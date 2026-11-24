import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Icon } from '@/components/icons';
import { PLANS, planByCode } from '@/lib/plans';
import { missingConfig } from '@/lib/config';
import type { PageProps } from '@/lib/data';

export const metadata = { title: 'Get started' };
export const dynamic = 'force-dynamic';

/** Step 1 of sign-up: continue with Google. Step 2 (/welcome) is picking the plan and naming the company. */
export default async function Signup({ searchParams }: PageProps) {
  const sp = await searchParams;
  const plan = planByCode(sp.plan);
  const next = `/welcome${plan ? `?plan=${plan.code}` : ''}`;
  if ((await cookies()).get('ht_session')) redirect(next);
  const offline = missingConfig().length > 0;
  return (
    <section className="site-sec"><div className="site-wrap" style={{ maxWidth: 560 }}>
      <div className="card" style={{ padding: 32, margin: 0 }}>
        <ol className="stepper" aria-label="Sign-up steps"><li className="on" aria-current="step"><span className="n">1</span>Sign in</li><li><span className="n">2</span>Choose a plan and name your company</li></ol>
        <h1>Create your company on humanTech</h1>
        <p className="muted" style={{ marginTop: 8 }}>It takes about a minute. First sign in with your Google account, then pick a plan and name your company. No card is needed.</p>
        {plan && <div className="callout ok" style={{ marginTop: 16 }}><Icon name="check" size={18} /><div><strong>You chose {plan.name}{plan.price ? ` · ${plan.price} ${plan.per}` : ''}</strong><p>You can change this on the next step.</p></div></div>}
        {offline
          ? <p className="flash warn" role="alert" style={{ marginTop: 16 }}>Sign-up is not available on this site yet. Please try again later.</p>
          : <a className="btn primary lg block" href={`/auth/login?returnTo=${encodeURIComponent(next)}`} style={{ marginTop: 16 }}>Continue with Google <Icon name="arrowRight" size={16} /></a>}
        <p className="hint" style={{ textAlign: 'center', marginTop: 10 }}>We only use your Google account to sign you in. We never see your password.</p>
        <ul className="plan-feat" style={{ marginTop: 20 }}>
          {PLANS.map((p) => <li key={p.code}><Icon name="check" size={16} /><span><strong>{p.name}</strong>: {p.people.toLowerCase()}{p.price ? `, ${p.price} ${p.per}` : ', tailored quote'}</span></li>)}
        </ul>
        <div className="auth-foot">
          <span>Already have an account? <Link href="/login">Sign in</Link></span>
          <span>Invited by your company? Use the link in your invitation email instead.</span>
        </div>
      </div>
    </div></section>
  );
}
