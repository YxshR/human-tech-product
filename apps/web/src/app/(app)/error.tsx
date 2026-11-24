'use client';
import { useEffect } from 'react';
import { Icon } from '@/components/icons';

/** A page inside the app failed to load. The menu stays, so the person can simply go somewhere else. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="statuspage">
      <div className="card" role="alert">
        <div className="ico bad"><Icon name="alert" size={26} /></div>
        <h1>This page could not be loaded</h1>
        <p className="muted">We could not get the information for this page. It is usually a brief connection problem and trying again fixes it. The rest of the app is still available from the menu{error.digest ? <>. If it keeps happening, quote reference <code>{error.digest}</code> to your administrator</> : null}.</p>
        <div className="row"><button className="btn primary" onClick={reset}>Try again</button><a className="btn" href="/dashboard">Go to Home</a></div>
      </div>
    </div>
  );
}
