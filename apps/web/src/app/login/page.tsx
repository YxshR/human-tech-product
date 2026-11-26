import Link from 'next/link';
import { missingConfig } from '@/lib/config';
import { DEV_ACCOUNTS, devLoginEnabled } from '@/lib/dev-login';
import { safeReturnTo } from '@/lib/pkce';
import { Icon } from '@/components/icons';
import type { PageProps } from '@/lib/data';
import { readAuthMsg } from '@/lib/session';

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
  const error = sp.error ? (MESSAGES[sp.error] ?? 'Something went wrong. Please try again.') : ((await readAuthMsg()) ?? null);
  const sso = missing.length === 0;
  return (
    <div className="auth-wrap">
      <main className="card" id="main">
        <Link href="/" className="logo" aria-label="humanTech home" style={{ textDecoration: 'none' }}>h</Link>
        <h1>Sign in to human<span style={{ color: 'var(--brand)' }}>Tech</span></h1>
        <p className="muted">Your company&apos;s people, attendance, leave and payroll in one place.</p>
        {error && <div className="flash err" role="alert" style={{ marginTop: 14 }}><Icon name="alert" size={18} /><div><strong>We could not sign you in</strong><span>{error}</span></div></div>}
        <form action="/auth/password" method="post" className="form" style={{ marginTop: 16 }}>
          <input type="hidden" name="returnTo" value={returnTo} />
          {dev && <span className="site-pill warn" style={{ justifySelf: 'start' }}>Demo accounts work on this computer only</span>}
          <label>Email<input name="email" type="email" required defaultValue={dev ? 'owner@demo.test' : ''} autoComplete="username" /></label>
          <label>Password<input name="password" type="password" required defaultValue={dev ? 'Demo@12345' : ''} autoComplete="current-password" /></label>
          <button className="btn primary lg block">Sign in</button>
          <p className="hint" style={{ textAlign: 'center' }}><strong style={{ color: 'var(--text)' }}>First time, with a login code from your company?</strong> <Link href="/activate">Set up your password</Link></p>
          {dev && (
            <>
              <div className="divider">or sign in as a demo role in one click</div>
              <div className="quick-grid">{DEV_ACCOUNTS.map((a) => <button key={a.email} className="btn sm" name="quickEmail" value={a.email} formNoValidate formAction="/auth/dev?quick=1" type="submit"><span>{a.role}</span><small className="muted">{a.email.split('@')[0]}</small></button>)}</div>
            </>
          )}
        </form>
        {!dev && sso && (
          <>
            <div className="divider">or</div>
            <a className="btn lg block" href={href}>Sign in with your work account <Icon name="arrowRight" size={16} /></a>
            <p className="hint" style={{ textAlign: 'center', marginTop: 10 }}>For companies that sign in through Google or another work account.</p>
          </>
        )}
        <div className="auth-foot">
          <span><strong style={{ color: 'var(--text)' }}>Forgot your password?</strong> Ask your HR or company administrator to help you sign in again.</span>
          <span><strong style={{ color: 'var(--text)' }}>Setting up a new company?</strong> <Link href="/signup">Get started free</Link> · <Link href="/pricing">See plans</Link></span>
        </div>
      </main>
    </div>
  );
}
