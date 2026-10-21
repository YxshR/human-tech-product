'use client';
import { Logo } from '@/components/icons';

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="auth-wrap">
      <main className="auth-card" role="alert">
        <Logo />
        <h1>Something went wrong</h1>
        <p>Please try again. If it keeps happening, contact support.</p>
        <button className="btn primary" onClick={reset}>Try again</button>
      </main>
    </div>
  );
}
