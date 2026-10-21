import Link from 'next/link';
import type { EmployeeView } from '@humantech/contracts';
import { api, ApiFailure } from '@/lib/api';

export const metadata = { title: 'Employees' };

interface Page { data: EmployeeView[]; page: { nextCursor: string | null; limit: number } }

export default async function Employees({ searchParams }: { searchParams: Promise<{ q?: string; cursor?: string; status?: string }> }) {
  const sp = await searchParams;
  let res: Page;
  try {
    res = await api<Page>('/employees', { query: { q: sp.q, cursor: sp.cursor, status: sp.status, limit: '25' } });
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 403) return <div className="card"><h1>Employees</h1><p className="muted">You do not have access to the employee directory.</p></div>;
    throw e;
  }
  return (
    <>
      <div className="topbar">
        <h1>Employees</h1>
        <Link className="btn primary" href="/employees/new">Add employee</Link>
      </div>
      <form className="row card" role="search" style={{ marginBottom: 16 }}>
        <label>Search<input name="q" defaultValue={sp.q} placeholder="Name, number or email" /></label>
        <label>Status
          <select name="status" defaultValue={sp.status ?? ''}>
            <option value="">All</option>
            {['onboarding', 'active', 'probation', 'on_notice', 'exited', 'archived'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>No.</th><th>Name</th><th>Email</th><th>Status</th></tr></thead>
          <tbody>
            {res.data.map((e) => (
              <tr key={e.id}>
                <td>{e.employeeNumber}</td>
                <td><Link href={`/employees/${e.id}`}>{e.firstName} {e.lastName ?? ''}</Link></td>
                <td>{e.workEmail ?? <span className="muted">—</span>}</td>
                <td><span className="pill">{e.employmentStatus.replace('_', ' ')}</span></td>
              </tr>
            ))}
            {res.data.length === 0 && <tr><td colSpan={4} className="muted">No employees found.</td></tr>}
          </tbody>
        </table>
      </div>
      {res.page.nextCursor && (
        <p><Link className="btn" href={{ pathname: '/employees', query: { ...(sp.q ? { q: sp.q } : {}), ...(sp.status ? { status: sp.status } : {}), cursor: res.page.nextCursor } }}>Next page →</Link></p>
      )}
    </>
  );
}
