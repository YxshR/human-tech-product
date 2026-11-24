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
      <div className="card" style={{ textAlign: 'center', padding: 36 }}>
        <h1>Get started with humanTech</h1>
        <p className="muted">Sign in with Google, choose a plan and name your company. It takes about a minute, and you can start on the free plan with no card.</p>
        {plan && <p style={{ marginTop: 12 }}>You chose <strong>{plan.name}</strong>{plan.price ? ` (${plan.price} ${plan.per})` : ''}.</p>}
        {offline
          ? <p className="flash" role="alert" style={{ background: 'var(--warn-soft)' }}>Sign-in is not configured on this deployment yet.</p>
          : <a className="btn primary lg" href={`/auth/login?returnTo=${encodeURIComponent(next)}`} style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}>Continue with Google <Icon name="arrowRight" size={16} /></a>}
        <ul className="plan-feat" style={{ marginTop: 22, textAlign: 'left' }}>
          {PLANS.map((p) => <li key={p.code}><Icon name="check" size={16} /><span><strong>{p.name}</strong>: {p.people}{p.price ? `, ${p.price} ${p.per}` : ', tailored quote'}</span></li>)}
        </ul>
        <p className="muted" style={{ marginTop: 18 }}>Already have an account? <Link href="/login">Sign in</Link></p>
      </div>
    </div></section>
  );
}
