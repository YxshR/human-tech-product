import Link from 'next/link';
import { Logo } from '@/components/icons';

export default function NotFound() {
  return (
    <div className="auth-wrap">
      <main className="auth-card">
        <Logo />
        <h1>Page not found</h1>
        <p>This page does not exist, or you do not have access to it.</p>
        <Link className="btn primary" href="/dashboard">Back to home</Link>
      </main>
    </div>
  );
}
