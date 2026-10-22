'use client';
import { useEffect, useState } from 'react';
import { Icon } from './icons';

/** A short-lived success message. The server still renders it from ?ok=, so it works without JavaScript; here we also tidy the address bar. */
export function Toast({ message }: { message: string }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.has('ok')) { u.searchParams.delete('ok'); window.history.replaceState(null, '', u.pathname + (u.search || '') + u.hash); }
    } catch { /* leave the URL as it is */ }
    const t = setTimeout(() => setShown(false), 5200);
    return () => clearTimeout(t);
  }, []);
  if (!shown) return null;
  return (
    <div className="toasts" aria-live="polite">
      <div className="toast" role="status" data-toast>
        <span className="t-ico"><Icon name="check" size={16} /></span>
        <div className="t-body">{message}</div>
        <button type="button" onClick={() => setShown(false)} aria-label="Dismiss"><Icon name="x" size={16} /></button>
        <i className="t-time" />
      </div>
    </div>
  );
}
