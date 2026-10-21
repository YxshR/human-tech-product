'use client';
import { useActionState } from 'react';

type State = { errors?: Record<string, string> } | undefined;

export function NewForm({ action }: { action: (prev: State, fd: FormData) => Promise<State> }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const e = state?.errors ?? {};
  const field = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label>{label}
      <input name={name} aria-invalid={!!e[name]} aria-describedby={e[name] ? `${name}-err` : undefined} {...props} />
      {e[name] && <span id={`${name}-err`} className="err">{e[name]}</span>}
    </label>
  );
  return (
    <>
      <div className="topbar"><h1>Add employee</h1></div>
      <form action={formAction} className="form card">
        {e._form && <p className="err" role="alert">{e._form}</p>}
        {field('firstName', 'First name', { required: true, maxLength: 100, autoComplete: 'off' })}
        {field('lastName', 'Last name', { maxLength: 100 })}
        {field('workEmail', 'Work email', { type: 'email' })}
        {field('branchId', 'Branch id', { required: true, pattern: '[0-9a-fA-F-]{36}', title: 'Branch UUID' })}
        {field('joinedAt', 'Joining date', { type: 'date' })}
        <button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Create employee'}</button>
      </form>
    </>
  );
}
