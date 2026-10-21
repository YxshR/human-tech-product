import Link from 'next/link';
import type { EmployeeView } from '@humantech/contracts';
import { can, loadPaged, type PageProps } from '@/lib/data';
import { Card, Empty, Page, Pager, Pill, Table, humanize } from '@/components/ui';

export const metadata = { title: 'Employees' };
const STATUSES = ['onboarding', 'active', 'probation', 'on_notice', 'exited', 'archived'];

export default async function Employees({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status ?? '') ? sp.status : undefined;
  const res = await loadPaged<EmployeeView>('/employees', { q: sp.q, cursor: sp.cursor, status, limit: '25' });
  const create = await can('employee.create');
  return (
    <Page title="Employees" sp={sp} actions={create ? <Link className="btn primary" href="/employees/new">Add employee</Link> : undefined}>
      {res === null ? <Empty>You do not have access to the employee directory.</Empty> : (
        <>
          <form className="row card" role="search" style={{ marginBottom: 16 }}>
            <label>Search<input name="q" defaultValue={sp.q} placeholder="Name, number or email" /></label>
            <label>Status
              <select name="status" defaultValue={status ?? ''}>
                <option value="">All</option>
                {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </select>
            </label>
            <button className="btn">Filter</button>
          </form>
          <Card wide>
            <Table rows={res.rows} cols={[
              { h: 'No.', c: (e) => e.employeeNumber }, { h: 'Name', c: (e) => <Link href={`/employees/${e.id}`}>{e.firstName} {e.lastName ?? ''}</Link> },
              { h: 'Email', c: (e) => e.workEmail ?? '—' }, { h: 'Status', c: (e) => <Pill tone={e.employmentStatus === 'active' ? 'ok' : undefined}>{humanize(e.employmentStatus)}</Pill> },
            ]} empty="No employees found." />
          </Card>
          <Pager base="/employees" query={{ q: sp.q, status }} nextCursor={res.next} />
        </>
      )}
    </Page>
  );
}
