import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: { default: 'humanTech HRMS', template: '%s · humanTech' }, robots: { index: false, follow: false } };

/** Sets the saved theme before first paint so the page never flashes the wrong colours. */
const THEME_INIT = "try{var t=localStorage.getItem('ht_theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT }} /></head>
      <body>{children}</body>
    </html>
  );
}
