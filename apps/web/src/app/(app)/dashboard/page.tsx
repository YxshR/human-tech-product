import Link from 'next/link';
import type { LeaveBalanceView } from '@humantech/contracts';
import { api } from '@/lib/api';
import { can, load, type PageProps } from '@/lib/data';
import { Card, Page, Pill, Stat, Table, fmtDateTime } from '@/components/ui';

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

  const hour = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const name = me.data.email.split('@')[0]!.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const totalLeave = balances?.reduce((n, b) => n + Number(b.availableDays), 0);

  return (
    <Page title="" sp={sp}>
      <section className="hero">
        <h1>{greeting}, {name}</h1>
        <p>{notes.unread > 0 ? `You have ${notes.unread} unread notification${notes.unread > 1 ? 's' : ''}.` : 'You are all caught up. Here is what is happening in your company.'}</p>
      </section>

      <div className="stats">
        <Stat label="Unread notifications" value={notes.unread} icon="bell" href="/notifications" />
        {totalLeave !== undefined && <Stat label="Leave days available" value={Number.isFinite(totalLeave) ? totalLeave : '—'} icon="calendar" tone="ok" href="/leave" />}
        {billing?.plan && <Stat label={`Active employees · ${billing.plan.name}`} value={`${billing.usage.activeEmployees}${billing.plan.maxActiveEmployees ? ` / ${billing.plan.maxActiveEmployees}` : ''}`} icon="users" href="/employees" />}
        {payroll && <Stat label="Payroll" value={payroll.activated ? 'Active' : 'Not active'} icon="banknote" tone={payroll.activated ? 'ok' : 'warn'} href="/payroll" />}
      </div>

      <div className="grid2">
        <Card title={`Notifications${notes.unread ? ` (${notes.unread} new)` : ''}`} wide>
          {notes.data.length === 0 ? <p className="muted">You are all caught up.</p> : (
            <ul className="feed">{notes.data.map((n) => (
              <li key={n.id}><span className={`dot ${n.readAt ? '' : 'new'}`} /><div><strong>{n.title}</strong>{!n.readAt && <> <Pill tone="ok">new</Pill></>}{n.body && <div className="muted">{n.body}</div>}<div className="muted" style={{ fontSize: 12 }}>{fmtDateTime(n.createdAt)}</div></div></li>
            ))}</ul>
          )}
          <p style={{ marginBottom: 0 }}><Link href="/notifications">All notifications →</Link></p>
        </Card>
        {shown.length > 0 && <Card title="Quick actions" wide><div className="actions-grid">{shown.map(([h, l]) => <Link key={h} className="btn" href={h}>{l}</Link>)}</div></Card>}
      </div>

      {balances && balances.length > 0 && (
        <Card title="My leave balances" wide>
          <Table rows={balances} cols={[{ h: 'Leave type', c: (b) => b.leaveTypeName }, { h: 'Pending', right: true, c: (b) => b.pendingDays }, { h: 'Available', right: true, c: (b) => b.availableDays }]} />
        </Card>
      )}
      {payroll && !payroll.activated && (
        <Card title="Payroll" wide><p style={{ margin: 0 }}><Pill tone="warn">not active</Pill> {payroll.activationRequestedAt ? `Activation requested ${fmtDateTime(payroll.activationRequestedAt)}; waiting for the humanTech team.` : 'Request activation from the Payroll page.'}</p></Card>
      )}
    </Page>
  );
}
