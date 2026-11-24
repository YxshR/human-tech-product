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
  apidown: 'Signed in, but the API is not reachable at API_URL. Start it (pnpm dev starts it for you) and try again.',
  apireject: 'Signed in, but the API rejected the token. The API must run with OIDC_ISSUER=http://localhost:3000/dev-idp and OIDC_AUDIENCE=humantech-api. Stop any old API on port 4000 and run pnpm dev again.',
  expired: 'Your session ended. Please sign in again.',
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
        <Link href="/" className="logo" aria-label="humanTech home" style={{ textDecoration: 'none' }}>h</Link>
        <h1>Sign in to human<span style={{ color: 'var(--brand)' }}>Tech</span></h1>
        <p className="muted">Your company&apos;s people, attendance, leave and payroll in one place.</p>
        {error && <div className="flash err" role="alert" style={{ marginTop: 14 }}><Icon name="alert" size={18} /><div><strong>We could not sign you in</strong><span>{error}</span></div></div>}
        {dev && (
          <form action="/auth/dev" method="post" className="form" style={{ marginTop: 16 }}>
            <input type="hidden" name="returnTo" value={returnTo} />
            <span className="site-pill warn" style={{ justifySelf: 'start' }}>Developer sign-in · this computer only</span>
            <label>Email<input name="email" type="email" required defaultValue="owner@demo.test" autoComplete="username" /></label>
            <label>Password<input name="password" type="password" required defaultValue="Demo@12345" autoComplete="current-password" /></label>
            <button className="btn primary lg block">Sign in</button>
            <div className="divider">or sign in as a demo role in one click</div>
            <div className="quick-grid">{DEV_ACCOUNTS.map((a) => <button key={a.email} className="btn sm" name="quickEmail" value={a.email} formNoValidate formAction="/auth/dev?quick=1" type="submit"><span>{a.role}</span><small className="muted">{a.email.split('@')[0]}</small></button>)}</div>
          </form>
        )}
        {!dev && (missing.length > 0 ? (
          <div className="flash warn" role="alert" style={{ marginTop: 16 }}>
            <strong>Sign-in is not set up on this site yet.</strong>
            <p style={{ margin: '6px 0' }}>If you run this site: add these environment variables where the web app is hosted, then redeploy.</p>
            <ul className="plain-list">{missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
          </div>
        ) : (
          <>
            <a className="btn primary lg block" href={href} style={{ marginTop: 20 }}>Continue to sign in <Icon name="arrowRight" size={16} /></a>
            <p className="hint" style={{ textAlign: 'center', marginTop: 10 }}>You sign in with your work account. We never see your password.</p>
          </>
        ))}
        <div className="auth-foot">
          <span><strong style={{ color: 'var(--text)' }}>Joining your company?</strong> Use the link in your invitation email. No invitation? Ask your administrator to send one.</span>
          <span><strong style={{ color: 'var(--text)' }}>Setting up a new company?</strong> <Link href="/signup">Get started free</Link> · <Link href="/pricing">See plans</Link></span>
        </div>
      </main>
    </div>
  );
}
