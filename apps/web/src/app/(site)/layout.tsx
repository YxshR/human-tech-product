import { SiteFooter, SiteHeader } from '@/components/site';

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  return (<div className="site"><a className="skip" href="#main">Skip to content</a><SiteHeader /><main id="main">{children}</main><SiteFooter /></div>);
}
