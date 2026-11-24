import type { ProfileChangeView } from '@humantech/contracts';
import { MARITAL } from '@humantech/contracts';
import { load, myself, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Callout, Card, Empty, Page, Pill, Table, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'My profile' };

export default async function Me({ searchParams }: PageProps) {
  const sp = await searchParams;
  const me = await myself();
  if (!me.employeeId) return <Page title="My profile" sub="Your own details in this company." sp={sp}><Card><Empty icon="user" title="This sign-in has no employee profile">You can use the app with your role, but personal pages (profile, leave, attendance, payslips) need an employee record. If you are also an employee here, ask HR to link your sign-in on your employee page.</Empty></Card></Page>;
  const mine = (await load<ProfileChangeView[]>('/profile-changes')) ?? [];
  const pending = mine.some((c) => c.employeeId === me.employeeId && c.status === 'pending');
  return (
    <Page title="My profile" sub="Ask HR to update your contact details or address, and follow your requests." sp={sp} actions={<a className="btn" href={`/employees/${me.employeeId}`}>See my full record</a>}>
      <Card title="Ask for a change" desc="Fill in only what should change and leave the rest empty. HR reviews every request before your record is updated.">
        {pending ? <Callout tone="warn" title="You already have a request waiting"><p>You can send another once HR has reviewed it, or cancel it below.</p></Callout> : (
          <ActionForm cols path="/profile-changes" back="/me" ok="Sent to HR for review" button="Send for review" fields={[
            { name: 's:changes.phone', label: 'Phone', kind: 'tel' }, { name: 's:changes.personalEmail', label: 'Personal email', kind: 'email' },
            { name: 's:changes.maritalStatus', label: 'Marital status', kind: 'select', options: MARITAL.map((m) => [m, humanize(m)]) },
            { name: 's:changes.currentAddress.line1', label: 'New address: house, street' }, { name: 's:changes.currentAddress.city', label: 'City' }, { name: 's:changes.currentAddress.state', label: 'State' }, { name: 's:changes.currentAddress.postalCode', label: 'PIN code' },
          ]} />
        )}
      </Card>
      <Card title="My requests" wide>
        <Table rows={mine.filter((c) => c.employeeId === me.employeeId)} cols={[
          { h: 'Sent', c: (c) => fmtDateTime(c.createdAt) }, { h: 'What you asked to change', c: (c) => Object.keys(c.changes).map(humanize).join(', ') },
          { h: 'Status', c: (c) => <Pill>{c.status === 'pending' ? 'Waiting' : c.status}</Pill> }, { h: 'HR comment', c: (c) => c.reviewComment ?? '' },
          { h: '', c: (c) => c.status === 'pending' && <ActionButton path={`/profile-changes/${c.id}/cancel`} back="/me" ok="Request cancelled" button="Cancel request" confirm="Cancel this change request?" /> },
        ]} empty={<Empty icon="edit" title="No requests yet">Requests you send to HR appear here with their status.</Empty>} />
      </Card>
    </Page>
  );
}
