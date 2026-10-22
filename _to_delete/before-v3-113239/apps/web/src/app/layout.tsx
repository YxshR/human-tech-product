import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = { title: { default: 'humanTech HRMS', template: '%s · humanTech' }, description: 'HR and payroll for growing Indian companies.', robots: { index: false, follow: false } };

/** Runs before first paint so the saved theme, accent and sidebar state never flash. */
const BOOT = `try{var d=document.documentElement,l=localStorage,t=l.getItem('ht-theme')||'system',a=l.getItem('ht-accent');d.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;if(a&&a!=='indigo')d.dataset.accent=a;if(l.getItem('ht-side')==='collapsed')d.dataset.side='collapsed'}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={inter.variable} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: BOOT }} /></head>
      <body>{children}</body>
    </html>
  );
}
