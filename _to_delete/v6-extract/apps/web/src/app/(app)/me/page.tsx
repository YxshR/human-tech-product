import type { ProfileChangeView } from '@humantech/contracts';
import { MARITAL } from '@humantech/contracts';
import { load, myself, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, Page, Pill, Table, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'My profile' };

export default async function Me({ searchParams }: PageProps) {
  const sp = await searchParams;
  const me = await myself();
  if (!me.employeeId) return <Page title="My profile" sp={sp}><Empty>Your login is not linked to an employee profile in this company.</Empty></Page>;
  const mine = (await load<ProfileChangeView[]>('/profile-changes')) ?? [];
  const pending = mine.some((c) => c.employeeId === me.employeeId && c.status === 'pending');
  return (
    <Page title="My profile" sub="See your details and ask for changes" sp={sp} actions={<a className="btn" href={`/employees/${me.employeeId}`}>Open my full profile</a>}>
      <Card title="Ask for a change">
        {pending ? <p>You already have a request waiting for review.</p> : (
          <ActionForm path="/profile-changes" back="/me" ok="Change request sent" button="Send for review" fields={[
            { name: 's:changes.phone', label: 'Phone', kind: 'tel' }, { name: 's:changes.personalEmail', label: 'Personal email', kind: 'email' },
            { name: 's:changes.maritalStatus', label: 'Marital status', kind: 'select', options: MARITAL.map((m) => [m, humanize(m)]) },
            { name: 's:changes.currentAddress.line1', label: 'Current address: line 1' }, { name: 's:changes.currentAddress.city', label: 'City' }, { name: 's:changes.currentAddress.state', label: 'State' }, { name: 's:changes.currentAddress.postalCode', label: 'PIN code' },
          ]} />
        )}
        <p className="muted">HR reviews every change before it is applied. Fill only what you want to change.</p>
      </Card>
      <Card title="My requests" wide>
        <Table rows={mine.filter((c) => c.employeeId === me.employeeId)} cols={[
          { h: 'Sent', c: (c) => fmtDateTime(c.createdAt) }, { h: 'Changes', c: (c) => Object.keys(c.changes).map(humanize).join(', ') },
          { h: 'Status', c: (c) => <Pill tone={c.status === 'approved' ? 'ok' : c.status === 'pending' ? 'warn' : 'bad'}>{c.status}</Pill> }, { h: 'Comment', c: (c) => c.reviewComment ?? '' },
          { h: '', c: (c) => c.status === 'pending' && <ActionButton path={`/profile-changes/${c.id}/cancel`} back="/me" ok="Request cancelled" button="Cancel" /> },
        ]} empty="No requests yet." />
      </Card>
    </Page>
  );
}
