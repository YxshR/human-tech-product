import Link from 'next/link';
import type { EmployeeView } from '@humantech/contracts';
import { can, loadPaged, type PageProps } from '@/lib/data';
import { Avatar, Card, Empty, Page, Pager, Pill, Table, humanize } from '@/components/ui';
import { Icon } from '@/components/icons';

export const metadata = { title: 'Employees' };
const STATUSES = ['onboarding', 'active', 'probation', 'on_notice', 'exited', 'archived'];

export default async function Employees({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status ?? '') ? sp.status : undefined;
  const res = await loadPaged<EmployeeView>('/employees', { q: sp.q, cursor: sp.cursor, status, limit: '25' });
  const create = await can('employee.create');
  return (
    <Page title="Employees" sub="Your people directory" sp={sp} actions={create ? <Link className="btn primary" href="/employees/new"><Icon name="plus" size={16} />Add employee</Link> : undefined}>
      {res === null ? <Empty>You do not have access to the employee directory.</Empty> : (
        <>
          <nav className="chips" aria-label="Filter by status">
            <Link className="chip" href={{ pathname: '/employees', query: sp.q ? { q: sp.q } : {} }} aria-current={status ? undefined : 'page'}>All</Link>
            {STATUSES.map((s) => <Link key={s} className="chip" href={{ pathname: '/employees', query: { ...(sp.q ? { q: sp.q } : {}), status: s } }} aria-current={status === s ? 'page' : undefined}>{humanize(s)}</Link>)}
          </nav>
          <Card wide>
            <form className="searchbar" role="search">
              <span className="search-ico"><Icon name="search" size={18} /></span>
              <input name="q" defaultValue={sp.q} placeholder="Search by name, number or email" aria-label="Search employees" />
              {status && <input type="hidden" name="status" value={status} />}
              <button className="btn">Search</button>
            </form>
            <Table rows={res.rows} cols={[
              { h: 'Employee', c: (e) => <Link className="person" href={`/employees/${e.id}`}><Avatar name={`${e.firstName} ${e.lastName ?? ''}`} /><span><strong>{e.firstName} {e.lastName ?? ''}</strong><span className="muted sub">{e.workEmail ?? 'No work email'}</span></span></Link> },
              { h: 'No.', c: (e) => e.employeeNumber },
              { h: 'Status', c: (e) => <Pill tone={e.employmentStatus === 'active' ? 'ok' : e.employmentStatus === 'on_notice' || e.employmentStatus === 'probation' ? 'warn' : undefined}>{humanize(e.employmentStatus)}</Pill> },
            ]} empty="No employees found." />
          </Card>
          <Pager base="/employees" query={{ q: sp.q, status }} nextCursor={res.next} />
        </>
      )}
    </Page>
  );
}
