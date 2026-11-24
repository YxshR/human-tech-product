import Link from 'next/link';
import type { EmployeeView } from '@humantech/contracts';
import { can, loadPaged, type PageProps } from '@/lib/data';
import { Avatar, Card, Empty, NoAccess, Page, Pager, Pill, Table, humanize } from '@/components/ui';
import { Icon } from '@/components/icons';

export const metadata = { title: 'Employees' };
const STATUSES = ['onboarding', 'active', 'probation', 'on_notice', 'exited', 'archived'];

export default async function Employees({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status ?? '') ? sp.status : undefined;
  const res = await loadPaged<EmployeeView>('/employees', { q: sp.q, cursor: sp.cursor, status, limit: '25' });
  const create = await can('employee.create'); const importer = await can('import.create');
  const filtered = !!(sp.q || status);
  return (
    <Page title="Employees" sub="Everyone in your company. Open a person to see their details, documents, salary and leave." sp={sp}
      actions={<>{importer && <Link className="btn" href="/imports"><Icon name="upload" size={16} />Import from CSV</Link>}{create && <Link className="btn primary" href="/employees/new"><Icon name="plus" size={16} />Add employee</Link>}</>}>
      {res === null ? <NoAccess what="the employee directory" /> : (
        <>
          <form className="row card" role="search">
            <label>Search<input name="q" type="search" defaultValue={sp.q} placeholder="Name, employee number or email" /></label>
            <label>Status
              <select name="status" defaultValue={status ?? ''}>
                <option value="">Any status</option>
                {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </select>
            </label>
            <button className="btn">Search</button>
            {filtered && <Link className="btn ghost" href="/employees">Clear</Link>}
          </form>
          <Card wide>
            <Table caption="Employees" rows={res.rows} cols={[
              { h: 'Name', c: (e) => { const n = `${e.firstName} ${e.lastName ?? ''}`.trim(); return <span className="cell-main"><Avatar name={n} size="sm" soft /><span><Link href={`/employees/${e.id}`}>{n}</Link></span></span>; } },
              { h: 'Employee no.', c: (e) => e.employeeNumber }, { h: 'Work email', c: (e) => e.workEmail ?? <span className="muted">Not set</span> }, { h: 'Type', c: (e) => humanize(e.employmentType) },
              { h: 'Status', c: (e) => <Pill>{e.employmentStatus}</Pill> },
              { h: '', c: (e) => <Link className="btn" href={`/employees/${e.id}`}>Open</Link> },
            ]} empty={filtered
              ? <Empty icon="search" title="No one matches" action={<Link className="btn" href="/employees">Clear search</Link>}>Try a different name or number, or clear the filters.</Empty>
              : <Empty icon="users" title="No employees yet" action={create ? <Link className="btn primary" href="/employees/new">Add your first employee</Link> : undefined}>People you add appear here.</Empty>} />
          </Card>
          <Pager base="/employees" query={{ q: sp.q, status }} nextCursor={res.next} started={!!sp.cursor} />
        </>
      )}
    </Page>
  );
}
