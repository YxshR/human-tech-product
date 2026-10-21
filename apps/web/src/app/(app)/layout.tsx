import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { api } from '@/lib/api';
import { TENANT_COOKIE, tenantCookie } from '@/lib/session';

interface Me { data: { email: string; companies: Array<{ id: string; name: string }> } }
interface Perms { data: { permissions: string[] } }

async function switchCompany(formData: FormData) {
  'use server';
  const id = String(formData.get('company') ?? '');
  const me = await api<Me>('/me', { tenant: false });
  if (me.data.companies.some((c) => c.id === id)) (await cookies()).set(tenantCookie(id));
  redirect('/employees');
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await api<Me>('/me', { tenant: false });
  const jar = await cookies();
  let tenantId = jar.get(TENANT_COOKIE)?.value;
  const valid = me.data.companies.some((c) => c.id === tenantId);
  if (!valid) {
    if (me.data.companies.length === 0) return <main className="main"><div className="card"><h1>No company access</h1><p className="muted">Your account ({me.data.email}) is not a member of any company yet. Ask your administrator for an invitation.</p></div></main>;
    tenantId = me.data.companies[0]!.id; // first visit: pick the first company (cookie set when the user switches)
  }
  const perms = await api<Perms>('/me/permissions', { tenant: true }).catch(() => ({ data: { permissions: [] as string[] } }));
  const can = (p: string) => perms.data.permissions.includes(p);
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">humanTech</div>
        <form action={switchCompany}>
          <label>Company
            <select name="company" defaultValue={tenantId}>{me.data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <button className="btn" style={{ marginTop: 6 }}>Switch</button>
        </form>
        {can('employee.read') && <a href="/employees">Employees</a>}
        <form action="/auth/logout" method="post" style={{ marginTop: 'auto' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{me.data.email}</div>
          <button className="btn">Sign out</button>
        </form>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
