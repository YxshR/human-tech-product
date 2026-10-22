import Link from 'next/link';
import { missingConfig } from '@/lib/config';
import { DEV_ACCOUNTS, devLoginEnabled } from '@/lib/dev-login';
import { safeReturnTo } from '@/lib/pkce';
import { Icon } from '@/components/icons';
import type { PageProps } from '@/lib/data';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  failed: 'Sign-in did not complete. Please try again.',
  unreachable: 'The sign-in provider could not be reached. Please try again in a moment.',
  config: 'Sign-in is not set up yet.',
  badcreds: 'Wrong e-mail or password.',
};

/** Public landing and sign-in page. It never needs a session, and explains clearly when the deployment is not configured. */
export default async function Login({ searchParams }: PageProps) {
  const sp = await searchParams;
  const dev = devLoginEnabled();
  const missing = dev ? [] : missingConfig();
  const returnTo = safeReturnTo(sp.returnTo);
  const href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const error = sp.error ? (MESSAGES[sp.error] ?? 'Something went wrong. Please try again.') : null;
  return (
    <div className="auth-wrap">
      <main className="card" id="main">
        <div className="logo" aria-hidden="true">h</div>
        <h1>Welcome to human<span style={{ color: 'var(--brand)' }}>Tech</span></h1>
        <p className="muted">HR, attendance, leave and payroll for your company, in one place.</p>
        {error && <p className="flash err" role="alert">{error}</p>}
        {dev && (
          <form action="/auth/dev" method="post" className="form" style={{ marginTop: 8 }}>
            <input type="hidden" name="returnTo" value={returnTo} />
            <span className="site-pill" style={{ background: 'var(--warn-soft)', color: 'var(--warn)', alignSelf: 'flex-start' }}>Developer sign-in · local only</span>
            <label>E-mail<input name="email" type="email" required defaultValue="owner@demo.test" autoComplete="username" /></label>
            <label>Password<input name="password" type="password" required defaultValue="Demo@12345" autoComplete="current-password" /></label>
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '12px 16px' }}>Sign in</button>
            <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>Or one click, no typing:</div>
            <div className="quick-grid">{DEV_ACCOUNTS.map((a) => <button key={a.email} className="btn sm" name="quickEmail" value={a.email} formNoValidate formAction="/auth/dev?quick=1" type="submit"><span>{a.role}</span><small className="muted">{a.email.split('@')[0]}</small></button>)}</div>
          </form>
        )}
        {!dev && (missing.length > 0 ? (
          <div className="flash" role="alert" style={{ background: 'var(--warn-soft)' }}>
            <strong>This deployment is missing settings.</strong>
            <p style={{ margin: '6px 0' }}>Add these environment variables where the web app is hosted, then redeploy:</p>
            <ul className="plain-list">{missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
          </div>
        ) : (
          <a className="btn primary" href={href} style={{ width: '100%', justifyContent: 'center', padding: '12px 16px', marginTop: 8 }}>Sign in <Icon name="arrowRight" size={16} /></a>
        ))}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 18 }}>Signing in with your company account. Joining a company? Ask your administrator for an invitation.</p>
        <p style={{ fontSize: 13.5, margin: '10px 0 0' }}>New here? <Link href="/signup">Get started</Link> · <Link href="/pricing">See plans</Link> · <Link href="/">Home</Link></p>
      </main>
    </div>
  );
}
