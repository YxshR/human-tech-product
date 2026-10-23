import { missingConfig } from '@/lib/config';
import { safeReturnTo } from '@/lib/pkce';
import { Icon } from '@/components/icons';
import type { PageProps } from '@/lib/data';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

/** Shown only on a developer machine that points sign-in at the local developer provider (`pnpm dev:idp`). Never in production. */
const devHint = () => process.env.NODE_ENV !== 'production' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(process.env.OIDC_ISSUER ?? '');

const MESSAGES: Record<string, string> = {
  failed: 'Sign-in did not complete. Please try again.',
  unreachable: 'The sign-in provider could not be reached. Please try again in a moment.',
  config: 'Sign-in is not set up yet.',
};

/** Public landing and sign-in page. It never needs a session, and explains clearly when the deployment is not configured. */
export default async function Login({ searchParams }: PageProps) {
  const sp = await searchParams;
  const missing = missingConfig();
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
        {missing.length > 0 ? (
          <div className="flash" role="alert" style={{ background: 'var(--warn-soft)' }}>
            <strong>This deployment is missing settings.</strong>
            <p style={{ margin: '6px 0' }}>Add these environment variables where the web app is hosted, then redeploy:</p>
            <ul className="plain-list">{missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
          </div>
        ) : (
          <a className="btn primary" href={href} style={{ width: '100%', justifyContent: 'center', padding: '12px 16px', marginTop: 8 }}>Sign in <Icon name="arrowRight" size={16} /></a>
        )}
        {devHint() && (
          <div className="flash" style={{ marginTop: 16, background: 'var(--warn-soft)' }}>
            <strong>Developer sign-in (local only)</strong>
            <p style={{ margin: '4px 0 0' }}>Password for all test accounts: <code>Demo@12345</code></p>
            <p style={{ margin: '4px 0 0' }}><code>owner@demo.test</code> · <code>hr@demo.test</code> · <code>finance@demo.test</code> · <code>approver@demo.test</code> · <code>recruiter@demo.test</code> · <code>manager@demo.test</code> · <code>employee@demo.test</code></p>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 18 }}>You will sign in with your company account. Need access? Ask your administrator for an invitation.</p>
      </main>
    </div>
  );
}
