'use client';
import { useEffect } from 'react';
import { Icon } from '@/components/icons';

/** Last-resort screen for the whole app. Says what happened in plain words and always offers a way forward. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="statuspage" id="main">
      <div className="card" role="alert">
        <div className="ico bad"><Icon name="alert" size={26} /></div>
        <h1>This page could not be loaded</h1>
        <p className="muted">Nothing you entered was lost on our side, but we could not finish loading this page. It is usually a brief connection problem. Try again, and if it keeps happening, tell your administrator{error.digest ? <> and quote reference <code>{error.digest}</code></> : null}.</p>
        <div className="row"><button className="btn primary" onClick={reset}>Try again</button><a className="btn" href="/dashboard">Go to Home</a></div>
      </div>
    </main>
  );
}
