'use client';
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return <main className="main"><div className="card" role="alert"><h1>Something went wrong</h1><p className="muted">Please try again. If it keeps happening, contact support.</p><button className="btn" onClick={reset}>Retry</button></div></main>;
}
