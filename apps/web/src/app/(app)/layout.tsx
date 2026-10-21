import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { api } from '@/lib/api';
import { TENANT_COOKIE, tenantCookie } from '@/lib/session';
import { ConfirmGuard } from '@/components/confirm';
import { Nav } from '@/components/nav';
import { Logo } from '@/components/icons';
import { Header } from '@/components/header';

interface Me { data: { email: string; companies: Array<{ id: string; name: string }> } }
interface Perms { data: { permissions: string[] } }

async function switchCompany(formData: FormData) {
  'use server';
  const id = String(formData.get('company') ?? '');
  const me = await api<Me>('/me', { tenant: false });
  if (me.data.companies.some((c) => c.id === id)) (await cookies()).set(tenantCookie(id));
  redirect('/dashboard');
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await api<Me>('/me', { tenant: false });
  const jar = await cookies();
  const tenantId = jar.get(TENANT_COOKIE)?.value;
  const valid = me.data.companies.some((c) => c.id === tenantId);
  if (!valid) {
    if (me.data.companies.length === 0) return (
      <div className="auth-wrap"><main className="auth-card">
        <Logo />
        <h1>No company access yet</h1>
        <p>You are signed in as <strong>{me.data.email}</strong>, but this account isn&rsquo;t a member of any company. Ask your administrator for an invitation, then open the link from the invitation email.</p>
        <form action="/auth/logout" method="post"><button className="btn">Sign out</button></form>
      </main></div>
    );
    // No (or a stale) company selected: pages cannot set cookies, so a route does it and brings the person straight back.
    redirect(`/auth/company?returnTo=${encodeURIComponent((await headers()).get('x-return-to') ?? '/dashboard')}`);
  }
  const perms = await api<Perms>('/me/permissions', { tenant: true }).catch(() => ({ data: { permissions: [] as string[] } }));
  const unread = await api<{ unread?: number }>('/me/notifications', { query: { limit: '1' } }).then((r) => r.unread ?? 0).catch(() => 0);
  return (
    <div className="shell">
      <input type="checkbox" id="navtoggle" className="nav-toggle sr" aria-label="Toggle navigation" />
      <label htmlFor="navtoggle" className="scrim" aria-hidden="true" />
      <aside className="side">
        <div className="brand"><Logo /><span className="brand-text">humanTech</span></div>
        <form action={switchCompany} className="company">
          <label>Company
            <select name="company" defaultValue={tenantId}>{me.data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          {me.data.companies.length > 1 && <button className="btn">Switch company</button>}
        </form>
        <Nav permissions={perms.data.permissions} unread={unread} />
      </aside>
      <div className="content">
        <Header company={me.data.companies.find((c) => c.id === tenantId)?.name ?? 'Company'} email={me.data.email} unread={unread} />
        <main className="main" id="main">{children}</main>
      </div>
      <ConfirmGuard />
    </div>
  );
}
