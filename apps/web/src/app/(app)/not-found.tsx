import Link from 'next/link';
import { Icon } from '@/components/icons';

export const metadata = { title: 'Page not found' };
export default function NotFound() {
  return (
    <div className="statuspage">
      <div className="card">
        <div className="ico"><Icon name="search" size={26} /></div>
        <h1>We could not find that page</h1>
        <p className="muted">The link may be old, the item may have been removed, or your role may not include it. Nothing is broken.</p>
        <div className="row"><Link className="btn primary" href="/dashboard">Go to Home</Link></div>
      </div>
    </div>
  );
}
