'use client';
import { useActionState } from 'react';

type State = { errors?: Record<string, string> } | undefined;
type Opt = Array<[string, string]>;

export function NewForm({ action, branches, departments, types }: { action: (prev: State, fd: FormData) => Promise<State>; branches: Opt; departments: Opt; types: Opt }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const e = state?.errors ?? {};
  const err = (name: string) => (e[name] ? <span id={`${name}-err`} className="err">{e[name]}</span> : null);
  const input = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label>{label}<input name={name} aria-invalid={!!e[name]} aria-describedby={e[name] ? `${name}-err` : undefined} {...props} />{err(name)}</label>
  );
  const select = (name: string, label: string, opts: Opt, required = false) => (
    <label>{label}{required ? ' *' : ''}
      <select name={name} required={required} defaultValue={required && opts.length === 1 ? opts[0]![0] : ''} aria-invalid={!!e[name]}>
        {!(required && opts.length === 1) && <option value="">{required ? 'Choose…' : '—'}</option>}
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>{err(name)}
    </label>
  );
  return (
    <>
      <div className="topbar"><h1>Add employee</h1></div>
      <form action={formAction} className="form card">
        {e._form && <p className="err" role="alert">{e._form}</p>}
        {input('firstName', 'First name *', { required: true, maxLength: 100, autoComplete: 'off' })}
        {input('lastName', 'Last name', { maxLength: 100 })}
        {input('workEmail', 'Work email', { type: 'email' })}
        {select('branchId', 'Branch', branches, true)}
        {select('departmentId', 'Department', departments)}
        {select('employmentType', 'Employment type', types)}
        {input('joinedAt', 'Joining date', { type: 'date' })}
        <button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Create employee'}</button>
      </form>
    </>
  );
}
