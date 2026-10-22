'use client';
import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

/** Submit button that shows progress and blocks double-clicks while the server action runs. */
export function SubmitButton({ children, tone, confirm }: { children: ReactNode; tone?: 'primary' | 'danger'; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button className={`btn ${tone ?? ''}`} disabled={pending} aria-busy={pending} {...(confirm ? { 'data-confirm': confirm } : {})}>
      {pending && <i className="spin" aria-hidden="true" />}{children}
    </button>
  );
}
