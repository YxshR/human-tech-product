'use client';
import { useActionState, useState } from 'react';
import { issueLoginCode, type LoginCodeState } from '@/lib/login-code';
import { Icon } from './icons';

const pretty = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * "Create login" for one employee. The company types the person's e-mail address, gets a one-time code, and hands over
 * three things: the sign-in address, the e-mail and the code. The person then chooses their own password.
 * With `mode="reset"` it makes a code for someone who forgot their password instead.
 */
export function LoginCodePanel({ employeeId, name, defaultEmail, roles, mode, appUrl }: {
  employeeId: string; name: string; defaultEmail?: string; roles?: Array<[string, string]>; mode: 'new' | 'reset'; appUrl: string;
}) {
  const [state, action, pending] = useActionState<LoginCodeState, FormData>(issueLoginCode, null);
  const [copied, setCopied] = useState(false);
  const url = `${(appUrl || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')}/activate`;

  if (state?.ok) {
    const text = `Sign-in page: ${url}\nE-mail: ${state.email}\nLogin code: ${pretty(state.code)}\n\nOpen the page, enter the e-mail and the code, and choose your own password. The code works once, until ${when(state.expiresAt)}.`;
    return (
      <div className="callout ok" role="status">
        <Icon name="check" size={18} />
        <div>
          <strong>{state.reset ? 'Password reset code created' : 'Login code created'}: give these three things to {name}</strong>
          <dl className="handover">
            <dt>Sign-in page</dt><dd><code>{url}</code></dd>
            <dt>E-mail</dt><dd><code>{state.email}</code></dd>
            <dt>Login code</dt><dd><code className="big">{pretty(state.code)}</code></dd>
          </dl>
          <p>{name} opens the page, enters the e-mail and the code, and chooses {state.reset ? 'a new' : 'their own'} password. The code works once and stops working on {when(state.expiresAt)}.</p>
          <p><strong>This code is shown only now.</strong> If it gets lost, create a new one: the old one stops working.</p>
          <div className="row">
            <button type="button" className="btn sm primary" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }); }}>
              <Icon name="check" size={14} />{copied ? 'Copied' : 'Copy all three'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="form">
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="mode" value={mode} />
      {state && !state.ok && <div className="flash err" role="alert"><Icon name="alert" size={18} /><div><strong>No code was created</strong><span>{state.error}</span></div></div>}
      {mode === 'new' && (
        <label><span>E-mail address {name} will sign in with<span className="req" aria-hidden="true">*</span></span>
          <input name="email" type="email" required defaultValue={defaultEmail ?? ''} autoComplete="off" />
          <span className="hint">They type this every time they sign in, so use an address they know well.</span>
        </label>
      )}
      {mode === 'new' && roles && roles.length > 0 && (
        <fieldset className="field">
          <legend>What can {name} do?</legend>
          <div className="checks">
            {roles.map(([key, label]) => (
              <label key={key} className="check"><input type="checkbox" name="roleKeys" value={key} defaultChecked={key === 'employee'} /><span>{label}</span></label>
            ))}
          </div>
          <span className="hint">Employee = their own profile, attendance, leave and payslips only. Tick more only for people who run things, such as HR. You can change this later under Users &amp; roles.</span>
        </fieldset>
      )}
      <button className="btn primary" disabled={pending} aria-busy={pending}>{pending && <i className="spin" aria-hidden="true" />}{mode === 'reset' ? 'Create password reset code' : 'Create login code'}</button>
    </form>
  );
}
