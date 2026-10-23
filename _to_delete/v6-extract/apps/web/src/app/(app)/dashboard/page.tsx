import Link from 'next/link';
import type { LeaveBalanceView } from '@humantech/contracts';
import { api } from '@/lib/api';
import { can, load, type PageProps } from '@/lib/data';
import { Card, Empty, Page, Pill, StatGrid, Table, fmtDateTime } from '@/components/ui';
import { Icon } from '@/components/icons';
import { QUICK_ACTIONS } from '@/lib/nav-items';

export const metadata = { title: 'Home' };

interface Notification { id: string; title: string; body: string | null; readAt: string | null; createdAt: string }
interface PayrollStatus { activated: boolean; activationRequestedAt: string | null }

const greeting = () => {
  const h = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

export default async function Dashboard({ searchParams }: PageProps) {
  const sp = await searchParams;
  const me = await api<{ data: { email: string } }>('/me', { tenant: false });
  const notes = await api<{ data: Notification[]; unread: number }>('/me/notifications', { query: { limit: '5' } }).catch(() => ({ data: [] as Notification[], unread: 0 }));
  const balances = (await can('leave.read_own')) ? await load<LeaveBalanceView[]>('/leave/balances') : null;
  const payroll = (await can('payroll.read')) ? await load<PayrollStatus>('/payroll/status') : null;
  const billing = (await can('subscription.read')) ? await load<{ usage: { activeEmployees: number }; plan: { maxActiveEmployees: number | null; name: string } | null }>('/billing') : null;
  const actions = [];
  for (const a of QUICK_ACTIONS) if (await can(...a.any)) actions.push(a);
  const name = (me.data.email.split('@')[0] ?? '').split(/[._-]+/)[0] ?? '';
  const leaveTotal = balances?.reduce((n, b) => n + Number(b.availableDays), 0);

  const stats = [
    { label: 'Unread notifications', value: notes.unread, icon: 'bell' as const, tone: notes.unread ? ('warn' as const) : ('ok' as const), href: '/notifications', sub: notes.unread ? 'Waiting for you' : 'All caught up' },
    ...(balances ? [{ label: 'Leave days available', value: leaveTotal !== undefined ? String(Math.round(leaveTotal * 100) / 100) : '—', icon: 'calendar' as const, tone: 'info' as const, href: '/leave', sub: `${balances.length} leave type${balances.length === 1 ? '' : 's'}` }] : []),
    ...(billing?.plan ? [{ label: 'Active employees', value: billing.usage.activeEmployees, icon: 'users' as const, href: '/employees', sub: billing.plan.maxActiveEmployees ? `of ${billing.plan.maxActiveEmployees} on ${billing.plan.name}` : billing.plan.name }] : []),
    ...(payroll ? [{ label: 'Payroll', value: payroll.activated ? 'Active' : 'Not active', icon: 'rupee' as const, tone: payroll.activated ? ('ok' as const) : ('warn' as const), href: '/payroll', sub: payroll.activated ? 'Switched on' : payroll.activationRequestedAt ? 'Activation requested' : 'Request activation' }] : []),
  ];

  return (
    <Page title="Home" sp={sp}>
      <section className="hero">
        <h1>{greeting()}{name ? `, ${name.charAt(0).toUpperCase()}${name.slice(1)}` : ''}</h1>
        <p>{notes.unread ? `You have ${notes.unread} new notification${notes.unread === 1 ? '' : 's'}.` : 'You are all caught up.'} Press <kbd>⌘K</kbd> or <kbd>/</kbd> anywhere to jump to a page or find a person.</p>
        {actions[0] && <div className="row"><Link className="btn primary" href={actions[0].href}>{actions[0].label}</Link></div>}
      </section>

      <StatGrid items={stats} />

      {actions.length > 0 && (
        <Card title="Quick actions" wide>
          <div className="actions-grid">{actions.map((a) => <Link key={a.href + a.label} href={a.href} className="action-tile"><span className="stat-ico"><Icon name={a.icon} size={18} /></span>{a.label}</Link>)}</div>
        </Card>
      )}

      <div className="grid2">
        <Card title={`Notifications${notes.unread ? ` (${notes.unread} new)` : ''}`} wide>
          {notes.data.length === 0 ? <Empty icon="bell" title="Nothing new">You are all caught up.</Empty> : (
            <ul className="feed">{notes.data.map((n) => (
              <li key={n.id} className={n.readAt ? '' : 'unread'}>
                <span className="ico"><Icon name="bell" size={16} /></span>
                <div><strong>{n.title}</strong>{!n.readAt && <> <Pill tone="ok">new</Pill></>}{n.body && <div className="muted">{n.body}</div>}<div className="muted" style={{ fontSize: 12 }}>{fmtDateTime(n.createdAt)}</div></div>
              </li>
            ))}</ul>
          )}
          <p style={{ marginTop: 14 }}><Link href="/notifications">All notifications →</Link></p>
        </Card>
        {balances && balances.length > 0 && (
          <Card title="My leave balances" wide>
            <Table rows={balances} cols={[{ h: 'Leave type', c: (b) => b.leaveTypeName }, { h: 'Pending', right: true, c: (b) => b.pendingDays }, { h: 'Available', right: true, c: (b) => b.availableDays }]} />
          </Card>
        )}
      </div>
      {payroll && !payroll.activated && (
        <Card title="Payroll" wide><p><Pill tone="warn">not active</Pill> {payroll.activationRequestedAt ? `Activation requested ${fmtDateTime(payroll.activationRequestedAt)}; waiting for the humanTech team.` : 'Request activation from the Payroll page.'}</p></Card>
      )}
    </Page>
  );
}
