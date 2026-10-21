import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { api } from '@/lib/api';
import { TENANT_COOKIE, tenantCookie } from '@/lib/session';
import { ConfirmGuard } from '@/components/confirm';
import { Nav } from '@/components/nav';

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
    if (me.data.companies.length === 0) return <main className="main"><div className="card"><h1>No company access</h1><p className="muted">Your account ({me.data.email}) is not a member of any company yet. Ask your administrator for an invitation, then open the link in the invitation email.</p><form action="/auth/logout" method="post"><button className="btn">Sign out</button></form></div></main>;
    // No (or a stale) company selected: pages cannot set cookies, so a route does it and brings the person straight back.
    redirect(`/auth/company?returnTo=${encodeURIComponent((await headers()).get('x-return-to') ?? '/dashboard')}`);
  }
  const perms = await api<Perms>('/me/permissions', { tenant: true }).catch(() => ({ data: { permissions: [] as string[] } }));
  const unread = await api<{ unread?: number }>('/me/notifications', { query: { limit: '1' } }).then((r) => r.unread ?? 0).catch(() => 0);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">humanTech</div>
        <form action={switchCompany}>
          <label>Company
            <select name="company" defaultValue={tenantId}>{me.data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <button className="btn" style={{ marginTop: 6 }}>Switch</button>
        </form>
        <Nav permissions={perms.data.permissions} unread={unread} />
        <form action="/auth/logout" method="post" style={{ marginTop: 'auto' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6, overflowWrap: 'anywhere' }}>{me.data.email}</div>
          <button className="btn">Sign out</button>
        </form>
      </aside>
      <main className="main" id="main">{children}</main>
      <ConfirmGuard />
    </div>
  );
}
