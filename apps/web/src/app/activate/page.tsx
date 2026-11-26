import Link from 'next/link';
import { PASSWORD_RULE } from '@humantech/contracts';
import { Icon } from '@/components/icons';
import { readAuthMsg } from '@/lib/session';

export const metadata = { title: 'Set up your sign-in' };
export const dynamic = 'force-dynamic';

/** First sign-in for someone whose company gave them an e-mail address and a login code. */
export default async function Activate() {
  const msg = await readAuthMsg();
  return (
    <div className="auth-wrap">
      <main className="card" id="main">
        <Link href="/" className="logo" aria-label="humanTech home" style={{ textDecoration: 'none' }}>h</Link>
        <h1>Set up your sign-in</h1>
        <p className="muted">First time here? Enter the e-mail address and the login code your company gave you, then choose your own password.</p>
        {msg && <div className="flash err" role="alert" style={{ marginTop: 14 }}><Icon name="alert" size={18} /><div><strong>That did not work</strong><span>{msg}</span></div></div>}
        <form action="/auth/activate" method="post" className="form" style={{ marginTop: 16 }}>
          <label>Your e-mail address<input name="email" type="email" required autoComplete="username" /><span className="hint">The address your company used for you.</span></label>
          <label>Login code<input name="code" required autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="ABCDE-FGHJK" maxLength={40} style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }} /><span className="hint">Ten letters and numbers. It works once and stops working after 7 days.</span></label>
          <label>Choose a password<input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" /><span className="hint">{PASSWORD_RULE}. Only you will know it.</span></label>
          <label>Type the password again<input name="confirm" type="password" required minLength={8} maxLength={128} autoComplete="new-password" /></label>
          <button className="btn primary lg block">Save password and sign in</button>
        </form>
        <div className="auth-foot">
          <span><strong style={{ color: 'var(--text)' }}>Already chose a password?</strong> <Link href="/login">Sign in</Link></span>
          <span><strong style={{ color: 'var(--text)' }}>No code, or it stopped working?</strong> Ask your HR or company administrator for a new one.</span>
        </div>
      </main>
    </div>
  );
}
