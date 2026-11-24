import Link from 'next/link';
import type { AttendanceDayView, LeaveBalanceView, LeaveRequestView, LeaveTypeView, ProfileChangeView } from '@humantech/contracts';
import { api } from '@/lib/api';
import { can, load, loadPaged, myself, today, type PageProps } from '@/lib/data';
import { ActionButton, Card, Empty, Flash, StatGrid, Table, fmtDateTime } from '@/components/ui';
import { Icon } from '@/components/icons';
import { QUICK_ACTIONS } from '@/lib/nav-items';

export const metadata = { title: 'Home' };

interface Notification { id: string; title: string; body: string | null; readAt: string | null; createdAt: string }
interface PayrollStatus { activated: boolean; activationRequestedAt: string | null }
interface Billing { usage: { activeEmployees: number; branches: number }; plan: { maxActiveEmployees: number | null; name: string } | null }

const greeting = () => {
  const h = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default async function Dashboard({ searchParams }: PageProps) {
  const sp = await searchParams;
  const me = await api<{ data: { email: string } }>('/me', { tenant: false });
  const notes = await api<{ data: Notification[]; unread: number }>('/me/notifications', { query: { limit: '5' } }).catch(() => ({ data: [] as Notification[], unread: 0 }));
  const balances = (await can('leave.read_own')) ? await load<LeaveBalanceView[]>('/leave/balances') : null;
  const payroll = (await can('payroll.read')) ? await load<PayrollStatus>('/payroll/status') : null;
  const billing = (await can('subscription.read')) ? await load<Billing>('/billing') : null;
  // Checking in belongs to an employee record; an administrator without one is not nagged about it.
  const punch = (await can('attendance.checkin_own')) && !!(await myself()).employeeId;
  const t = today();
  const todayRow = punch ? (await load<AttendanceDayView[]>('/attendance/days', { from: t, to: t }))?.[0] : undefined;

  // Things waiting for this person's decision.
  const leaveQueue = (await can('leave.approve', 'leave.reject')) ? await loadPaged<LeaveRequestView>('/leave/requests', { status: 'pending', limit: '20' }) : null;
  const changeQueue = (await can('profile.review_change')) ? await load<ProfileChangeView[]>('/profile-changes', { status: 'pending' }) : null;
  const waiting = [
    ...(leaveQueue && leaveQueue.rows.length ? [{ href: '/leave?tab=approvals', icon: 'calendar' as const, label: `${leaveQueue.rows.length}${leaveQueue.next ? '+' : ''} leave ${leaveQueue.rows.length === 1 ? 'request' : 'requests'} to decide`, hint: 'Approve or reject so people can plan' }] : []),
    ...(changeQueue && changeQueue.length ? [{ href: '/profile-changes', icon: 'edit' as const, label: `${plural(changeQueue.length, 'profile change')} to review`, hint: 'Employees asked to update their details' }] : []),
  ];

  // First-time set-up, shown to administrators until every step is done.
  const admin = await can('employee.create');
  const leaveTypes = admin && (await can('leave.manage_policy')) ? await load<LeaveTypeView[]>('/leave/types') : null;
  const users = admin && (await can('user.invite')) ? await load<unknown[]>('/access/users') : null;
  const setup = admin ? [
    { done: (billing?.usage.branches ?? 0) > 0, href: '/org', title: 'Set up your organisation', hint: 'Add your branches and departments' },
    { done: (billing?.usage.activeEmployees ?? 0) > 0, href: '/employees/new', title: 'Add your people', hint: 'One at a time, or import a CSV file' },
    ...(leaveTypes ? [{ done: leaveTypes.length > 0, href: '/leave/admin', title: 'Define leave types', hint: 'Casual, sick, earned… and how many days each' }] : []),
    ...(users ? [{ done: users.length > 1, href: '/access?tab=invitations', title: 'Invite your team', hint: 'Give HR, managers and employees their own sign-in' }] : []),
    ...(payroll ? [{ done: payroll.activated, href: '/payroll', title: 'Switch on payroll', hint: payroll.activationRequestedAt && !payroll.activated ? 'Requested: waiting for the humanTech team' : 'Request activation when you are ready to pay salaries' }] : []),
  ] : [];
  const setupLeft = setup.filter((s) => !s.done).length;

  const actions = [];
  for (const a of QUICK_ACTIONS) if (await can(...a.any)) actions.push(a);
  const name = (me.data.email.split('@')[0] ?? '').split(/[._-]+/)[0] ?? '';
  const leaveTotal = balances?.reduce((n, b) => n + Number(b.availableDays), 0);
  const dateLine = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });

  const stats = [
    { label: 'Notifications', value: notes.unread, icon: 'bell' as const, tone: notes.unread ? ('warn' as const) : ('ok' as const), href: '/notifications', sub: notes.unread ? 'Unread, waiting for you' : 'All caught up' },
    ...(balances ? [{ label: 'Leave you can take', value: leaveTotal !== undefined ? `${Math.round(leaveTotal * 100) / 100} days` : '—', icon: 'calendar' as const, tone: 'info' as const, href: '/leave', sub: `Across ${plural(balances.length, 'leave type')}` }] : []),
    ...(billing?.plan ? [{ label: 'Active employees', value: billing.usage.activeEmployees, icon: 'users' as const, href: '/employees', sub: billing.plan.maxActiveEmployees ? `of ${billing.plan.maxActiveEmployees} on the ${billing.plan.name} plan` : `${billing.plan.name} plan` }] : []),
    ...(payroll ? [{ label: 'Payroll', value: payroll.activated ? 'On' : 'Off', icon: 'rupee' as const, tone: payroll.activated ? ('ok' as const) : ('warn' as const), href: '/payroll', sub: payroll.activated ? 'Ready for pay runs' : payroll.activationRequestedAt ? 'Activation requested' : 'Not switched on yet' }] : []),
  ];

  return (
    <>
      <Flash sp={sp} />
      <section className="hero">
        <div className="eyebrow">{dateLine}</div>
        <h1>{greeting()}{name ? `, ${name.charAt(0).toUpperCase()}${name.slice(1)}` : ''}</h1>
        <p>
          {punch ? (todayRow?.checkInAt ? (todayRow.checkOutAt ? `You checked in at ${hm(todayRow.checkInAt)} and out at ${hm(todayRow.checkOutAt)}. ` : `You checked in at ${hm(todayRow.checkInAt)}. `) : 'You have not checked in yet today. ') : ''}
          {waiting.length ? 'A few things are waiting for you below.' : notes.unread ? `You have ${plural(notes.unread, 'unread notification')}.` : 'Nothing is waiting for you.'}
        </p>
        <div className="row">
          {punch && !todayRow?.checkInAt && <ActionButton path="/attendance/check-in" back="/dashboard" ok="Checked in. Have a good day!" button="Check in now" tone="primary" />}
          {punch && todayRow?.checkInAt && !todayRow.checkOutAt && <ActionButton path="/attendance/check-out" back="/dashboard" ok="Checked out. See you tomorrow!" button="Check out" tone="primary" />}
          {!punch && actions[0] && <Link className="btn primary" href={actions[0].href}>{actions[0].label}</Link>}
          {actions.some((a) => a.href === '/leave') && (punch || actions[0]?.href !== '/leave') && <Link className="btn" href="/leave">Apply for leave</Link>}
        </div>
      </section>

      <StatGrid items={stats} />

      {waiting.length > 0 && (
        <Card title="Waiting for you" desc="People are waiting on these decisions." wide>
          <div className="actions-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {waiting.map((w) => <Link key={w.href} href={w.href} className="action-tile"><span className="stat-ico warn"><Icon name={w.icon} size={18} /></span><span>{w.label}<small>{w.hint}</small></span></Link>)}
          </div>
        </Card>
      )}

      {setup.length > 0 && setupLeft > 0 && (
        <Card title="Finish setting up your company" desc={`${setup.length - setupLeft} of ${setup.length} steps done. Do them in any order; this card disappears when you are finished.`} wide>
          <ol className="steps-list">
            {setup.map((s) => (
              <li key={s.href} className={s.done ? 'done' : ''}>
                <span className="n" aria-hidden="true" />
                <span className="txt"><b>{s.title}</b><span>{s.hint}</span></span>
                {s.done ? <span className="muted sr">Done</span> : <Link className="btn sm" href={s.href}>Start<Icon name="arrowRight" size={14} /></Link>}
              </li>
            ))}
          </ol>
        </Card>
      )}

      {actions.length > 0 && (
        <Card title="Shortcuts" desc="The things people do most often." wide>
          <div className="actions-grid">{actions.map((a) => <Link key={a.href + a.label} href={a.href} className="action-tile"><span className="stat-ico"><Icon name={a.icon} size={18} /></span><span>{a.label}<small>{a.hint}</small></span></Link>)}</div>
        </Card>
      )}

      <div className="grid2">
        <Card title="Latest notifications" action={<Link className="btn sm" href="/notifications">See all</Link>} wide>
          {notes.data.length === 0 ? <Empty icon="bell" title="No notifications yet">When a request of yours is approved or a payslip is ready, you will see it here.</Empty> : (
            <ul className="feed">{notes.data.map((n) => (
              <li key={n.id} className={n.readAt ? '' : 'unread'}>
                <span className="ico"><Icon name="bell" size={16} /></span>
                <div><strong>{n.title}</strong>{n.body && <div className="muted">{n.body}</div>}<div className="when">{fmtDateTime(n.createdAt)}</div></div>
              </li>
            ))}</ul>
          )}
        </Card>
        {balances && balances.length > 0 && (
          <Card title="My leave" desc="Available = balance minus requests still waiting." action={<Link className="btn sm" href="/leave">Apply</Link>} wide>
            <Table rows={balances} cols={[{ h: 'Leave type', c: (b) => b.leaveTypeName }, { h: 'Waiting', right: true, c: (b) => b.pendingDays }, { h: 'Available', right: true, c: (b) => <strong>{b.availableDays}</strong> }]} />
          </Card>
        )}
      </div>
    </>
  );
}
