import Link from 'next/link';
import type { LeaveBalanceView } from '@humantech/contracts';
import { api } from '@/lib/api';
import { can, load, type PageProps } from '@/lib/data';
import { Card, Page, Pill, Table, fmtDateTime } from '@/components/ui';

export const metadata = { title: 'Home' };

interface Notification { id: string; title: string; body: string | null; readAt: string | null; createdAt: string }
interface PayrollStatus { activated: boolean; activationRequestedAt: string | null }

export default async function Dashboard({ searchParams }: PageProps) {
  const sp = await searchParams;
  const me = await api<{ data: { email: string } }>('/me', { tenant: false });
  const notes = await api<{ data: Notification[]; unread: number }>('/me/notifications', { query: { limit: '5' } }).catch(() => ({ data: [] as Notification[], unread: 0 }));
  const balances = (await can('leave.read_own')) ? await load<LeaveBalanceView[]>('/leave/balances') : null;
  const payroll = (await can('payroll.read')) ? await load<PayrollStatus>('/payroll/status') : null;
  const billing = (await can('subscription.read')) ? await load<{ usage: { activeEmployees: number }; plan: { maxActiveEmployees: number | null; name: string } | null }>('/billing') : null;
  const links: Array<[string, string, string[]]> = [
    ['/leave', 'Apply for leave', ['leave.request']], ['/attendance', 'Check in / out', ['attendance.checkin_own']], ['/employees/new', 'Add an employee', ['employee.create']],
    ['/payroll', 'Payroll runs', ['payroll.read']], ['/recruitment', 'Candidates', ['candidate.read']], ['/payslips', 'My payslips', ['payslip.read_own']],
  ];
  const shown: Array<[string, string]> = [];
  for (const [href, label, perms] of links) if (await can(...perms)) shown.push([href, label]);
  return (
    <Page title="Home" sub={me.data.email} sp={sp}>
      <div className="grid2">
        <Card title={`Notifications${notes.unread ? ` (${notes.unread} new)` : ''}`} wide>
          {notes.data.length === 0 ? <p className="muted">You are all caught up.</p> : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>{notes.data.map((n) => <li key={n.id} style={{ marginBottom: 6 }}><strong>{n.title}</strong>{!n.readAt && <> <Pill tone="ok">new</Pill></>}{n.body && <div className="muted">{n.body}</div>}<div className="muted" style={{ fontSize: 12 }}>{fmtDateTime(n.createdAt)}</div></li>)}</ul>
          )}
          <p><Link href="/notifications">All notifications →</Link></p>
        </Card>
        {shown.length > 0 && <Card title="Quick links" wide><div style={{ display: 'grid', gap: 6 }}>{shown.map(([h, l]) => <Link key={h} className="btn" href={h}>{l}</Link>)}</div></Card>}
      </div>
      {balances && balances.length > 0 && (
        <Card title="My leave balances" wide>
          <Table rows={balances} cols={[{ h: 'Leave type', c: (b) => b.leaveTypeName }, { h: 'Pending', right: true, c: (b) => b.pendingDays }, { h: 'Available', right: true, c: (b) => b.availableDays }]} />
        </Card>
      )}
      {(payroll || billing) && (
        <div className="grid2">
          {payroll && <Card title="Payroll" wide>{payroll.activated ? <p><Pill tone="ok">active</Pill> Payroll is switched on for your company.</p> : <p><Pill tone="warn">not active</Pill> {payroll.activationRequestedAt ? `Activation requested ${fmtDateTime(payroll.activationRequestedAt)}; waiting for the humanTech team.` : 'Request activation from the Payroll page.'}</p>}</Card>}
          {billing?.plan && <Card title="Plan" wide><p>{billing.plan.name}: {billing.usage.activeEmployees} active employees{billing.plan.maxActiveEmployees ? ` of ${billing.plan.maxActiveEmployees}` : ''}.</p></Card>}
        </div>
      )}
    </Page>
  );
}
