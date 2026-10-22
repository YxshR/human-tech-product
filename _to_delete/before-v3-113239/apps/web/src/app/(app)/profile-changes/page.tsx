import type { ProfileChangeView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionForm, Card, Empty, Page, Pill, Table, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'Profile changes' };

export default async function Changes({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = sp.status === 'approved' || sp.status === 'rejected' || sp.status === 'cancelled' ? sp.status : 'pending';
  const rows = await load<ProfileChangeView[]>('/profile-changes', { status });
  const review = await can('profile.review_change');
  return (
    <Page title="Profile changes" sub="Requests from employees to update their details" sp={sp}
      actions={<>{['pending', 'approved', 'rejected', 'cancelled'].map((s) => <a key={s} className={`btn ${s === status ? 'primary' : ''}`} href={`/profile-changes?status=${s}`}>{humanize(s)}</a>)}</>}>
      {rows === null ? <Empty>You do not have access.</Empty> : (
        <Card wide>
          <Table rows={rows} cols={[
            { h: 'Employee', c: (c) => c.employeeName }, { h: 'Sent', c: (c) => fmtDateTime(c.createdAt) },
            { h: 'Wants to change', c: (c) => <pre className="plain">{JSON.stringify(c.changes, null, 1)}</pre> }, { h: 'Status', c: (c) => <Pill tone={c.status === 'approved' ? 'ok' : c.status === 'pending' ? 'warn' : 'bad'}>{c.status}</Pill> },
            { h: '', c: (c) => review && c.status === 'pending' && (
              <>
                <ActionForm inline path={`/profile-changes/${c.id}/approve`} back={`/profile-changes?status=${status}`} ok="Change approved" button="Approve" fields={[{ name: 's:comment', label: 'Comment' }]} />
                <ActionForm inline path={`/profile-changes/${c.id}/reject`} back={`/profile-changes?status=${status}`} ok="Change rejected" button="Reject" tone="danger" fields={[{ name: 's:comment', label: 'Comment' }]} />
              </>
            ) },
          ]} empty="Nothing here." />
          <p className="muted">You cannot review your own request.</p>
        </Card>
      )}
    </Page>
  );
}
