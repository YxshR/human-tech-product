'use client';
import Link from 'next/link';
import { useActionState } from 'react';

type State = { errors?: Record<string, string> } | undefined;
type Opt = Array<[string, string]>;

export function NewForm({ action, branches, departments, types }: { action: (prev: State, fd: FormData) => Promise<State>; branches: Opt; departments: Opt; types: Opt }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const e = state?.errors ?? {};
  const err = (name: string) => (e[name] ? <span id={`${name}-err`} className="err">{e[name]}</span> : null);
  const input = (name: string, label: React.ReactNode, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <label><span>{label}</span><input name={name} aria-invalid={!!e[name]} aria-describedby={e[name] ? `${name}-err` : undefined} {...props} />{hint && !e[name] && <span className="hint">{hint}</span>}{err(name)}</label>
  );
  const select = (name: string, label: string, opts: Opt, required = false) => (
    <label><span>{label}{required && <span className="req" aria-hidden="true">*</span>}</span>
      <select name={name} required={required} defaultValue={required && opts.length === 1 ? opts[0]![0] : ''} aria-invalid={!!e[name]}>
        {!(required && opts.length === 1) && <option value="">{required ? 'Choose…' : '— None —'}</option>}
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>{err(name)}
    </label>
  );
  return (
    <>
      <div className="topbar"><div>
        <Link className="backlink" href="/employees">‹ Employees</Link>
        <h1>Add employee</h1>
        <p className="sub">Start with the basics. After saving you can add personal details, bank account, documents and salary on the employee&apos;s page.</p>
      </div></div>
      <form action={formAction} className="form cols card">
        {e._form && <div className="flash err full" role="alert"><div><strong>Please check the form</strong><span>{e._form}</span></div></div>}
        <div className="form-sec">Who</div>
        {input('firstName', <>First name<span className="req" aria-hidden="true">*</span></>, { required: true, maxLength: 100, autoComplete: 'off' })}
        {input('lastName', 'Last name', { maxLength: 100, autoComplete: 'off' })}
        {input('workEmail', 'Work email', { type: 'email', placeholder: 'name@company.com', autoComplete: 'off' }, 'Used to match their sign-in later. You can leave it empty for now.')}
        <div className="form-sec">Where and how they work</div>
        {select('branchId', 'Branch', branches, true)}
        {select('departmentId', 'Department', departments)}
        {select('employmentType', 'Employment type', types)}
        {input('joinedAt', 'Joining date', { type: 'date' })}
        <div className="form-actions"><button className="btn primary" disabled={pending} aria-busy={pending}>{pending && <i className="spin" aria-hidden="true" />}{pending ? 'Saving…' : 'Create employee'}</button><Link className="btn ghost" href="/employees">Cancel</Link></div>
      </form>
    </>
  );
}
