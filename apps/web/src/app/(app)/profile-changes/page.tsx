import Link from 'next/link';
import type { ProfileChangeView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionForm, Card, Details, Empty, NoAccess, Page, Pill, Table, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'Profile changes' };
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

/** Shows requested changes as "Field: new value" lines instead of raw data. */
function ChangeList({ changes }: { changes: Record<string, unknown> }) {
  const flat: Array<[string, string]> = [];
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const label = prefix ? `${prefix} · ${humanize(k).toLowerCase()}` : humanize(k);
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, label);
      else flat.push([label, v === null || v === '' ? '(cleared)' : Array.isArray(v) ? v.join(', ') : String(v)]);
    }
  };
  walk(changes ?? {}, '');
  if (flat.length === 0) return <span className="muted">No details</span>;
  return <dl className="changes">{flat.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export default async function Changes({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status! : 'pending';
  const rows = await load<ProfileChangeView[]>('/profile-changes', { status });
  const review = await can('profile.review_change');
  const back = `/profile-changes?status=${status}`;
  return (
    <Page title="Profile changes" sub="Employees ask to update their own details here. Nothing changes on their record until someone approves it." sp={sp}
      actions={<nav className="chips" aria-label="Filter by status">{STATUSES.map((s) => <Link key={s} href={`/profile-changes?status=${s}`} aria-current={s === status ? 'true' : undefined}>{s === 'pending' ? 'Waiting' : humanize(s)}</Link>)}</nav>}>
      {rows === null ? <NoAccess what="profile change requests" /> : (
        <Card wide>
          <Table caption="Profile change requests" rows={rows} cols={[
            { h: 'Employee', c: (c) => <Link href={`/employees/${c.employeeId}`}><strong>{c.employeeName}</strong></Link> }, { h: 'Asked on', c: (c) => fmtDateTime(c.createdAt) },
            { h: 'Wants to change', c: (c) => <ChangeList changes={c.changes} /> }, { h: 'Status', c: (c) => <><Pill>{c.status}</Pill>{c.reviewComment && <div className="muted">{c.reviewComment}</div>}</> },
            { h: '', c: (c) => review && c.status === 'pending' && (
              <>
                <ActionForm inline path={`/profile-changes/${c.id}/approve`} back={back} ok="Change approved and applied" button="Approve" tone="primary" />
                <Details summary="Reject"><ActionForm path={`/profile-changes/${c.id}/reject`} back={back} ok="Change rejected" button="Reject request" tone="danger" fields={[{ name: 's:comment', label: 'Reason (the employee sees this)' }]} /></Details>
              </>
            ) },
          ]} empty={<Empty icon="edit" title={status === 'pending' ? 'Nothing waiting for review' : `No ${status} requests`}>{status === 'pending' ? 'When an employee asks to change their details, it appears here.' : 'Try another status above.'}</Empty>} />
          {review && <p className="muted" style={{ marginTop: 12 }}>You cannot review a request you made yourself; a colleague has to.</p>}
        </Card>
      )}
    </Page>
  );
}
