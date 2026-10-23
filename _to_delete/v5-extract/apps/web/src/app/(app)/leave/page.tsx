import type { LeaveBalanceView, LeaveRequestView, LeaveTypeView } from '@humantech/contracts';
import { can, load, loadPaged, today, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Details, Empty, Page, Pager, Pill, Table, Tabs, fmtDate, humanize } from '@/components/ui';

export const metadata = { title: 'Leave' };
const TABS: Array<[string, string]> = [['mine', 'Balances & requests'], ['approvals', 'Waiting for a decision']];

const tone = (s: string) => (s === 'approved' ? 'ok' : s === 'pending' ? 'warn' : s === 'rejected' ? 'bad' : undefined);

export default async function Leave({ searchParams }: PageProps) {
  const sp = await searchParams;
  const approver = await can('leave.approve', 'leave.reject');
  const tabs = approver ? TABS : TABS.slice(0, 1);
  const tab = tabs.some(([k]) => k === sp.tab) ? sp.tab! : 'mine';
  const back = `/leave?tab=${tab}`;
  return (
    <Page title="Leave" sp={sp}>
      {tabs.length > 1 && <Tabs base="/leave" current={tab} items={tabs} />}
      {tab === 'mine' ? <Mine back={back} sp={sp} /> : <Approvals back={back} sp={sp} />}
    </Page>
  );
}

async function Mine({ back, sp }: { back: string; sp: { cursor?: string; status?: string } }) {
  const balances = await load<LeaveBalanceView[]>('/leave/balances');
  const types = ((await load<LeaveTypeView[]>('/leave/types')) ?? []).filter((t) => t.active);
  const requests = await loadPaged<LeaveRequestView>('/leave/requests', { cursor: sp.cursor, status: sp.status, limit: '15' });
  const apply = await can('leave.request');
  return (
    <>
      <div className="grid2">
        <Card title="My balances" wide>
          {balances === null ? <Empty>You do not have a leave balance (no employee record).</Empty> : <Table rows={balances} cols={[{ h: 'Leave type', c: (b) => b.leaveTypeName }, { h: 'Balance', right: true, c: (b) => b.balanceDays }, { h: 'Pending', right: true, c: (b) => b.pendingDays }, { h: 'Available', right: true, c: (b) => <strong>{b.availableDays}</strong> }]} empty="No balances yet." />}
        </Card>
        {apply && types.length > 0 && (
          <Card title="Apply for leave" wide>
            <ActionForm path="/leave/requests" back={back} ok="Leave requested" button="Submit request" fields={[
              { name: 's:leaveTypeId', label: 'Leave type', kind: 'select', required: true, options: types.map((t) => [t.id, `${t.name}${t.isPaid ? '' : ' (unpaid)'}`]) },
              { name: 'd:startDate', label: 'From', kind: 'date', required: true, value: today() }, { name: 'd:endDate', label: 'To', kind: 'date', required: true, value: today() },
              { name: 'z:partialDay', label: 'Half day (single date only)', kind: 'select', options: [['first_half', 'First half'], ['second_half', 'Second half']] }, { name: 'z:reason', label: 'Reason', kind: 'textarea' },
            ]} />
          </Card>
        )}
      </div>
      <Card title="My requests" wide>
        {requests === null ? <Empty>No access.</Empty> : <RequestTable rows={requests.rows} back={back} decide={false} />}
        <Pager base="/leave" query={{ tab: 'mine', status: sp.status }} nextCursor={requests?.next ?? null} />
      </Card>
    </>
  );
}

async function Approvals({ back, sp }: { back: string; sp: { cursor?: string } }) {
  const pending = await loadPaged<LeaveRequestView>('/leave/requests', { status: 'pending', cursor: sp.cursor, limit: '25' });
  if (pending === null) return <Empty>You do not have access to approvals.</Empty>;
  return (
    <Card wide>
      <RequestTable rows={pending.rows} back={back} decide />
      <Pager base="/leave" query={{ tab: 'approvals' }} nextCursor={pending.next} />
    </Card>
  );
}

function RequestTable({ rows, back, decide }: { rows: LeaveRequestView[]; back: string; decide: boolean }) {
  return (
    <Table rows={rows} cols={[
      { h: 'Who', c: (r) => <>{r.employeeName}<div className="muted">{r.employeeNumber}</div></> }, { h: 'Type', c: (r) => r.leaveTypeCode },
      { h: 'Dates', c: (r) => `${fmtDate(r.startDate)}${r.endDate !== r.startDate ? ` – ${fmtDate(r.endDate)}` : ''}${r.partialDay ? ` (${humanize(r.partialDay)})` : ''}` },
      { h: 'Days', right: true, c: (r) => r.requestedDays }, { h: 'Reason', c: (r) => r.reason ?? '—' },
      { h: 'Status', c: (r) => <><Pill tone={tone(r.status)}>{r.status}</Pill>{r.autoApproved && <> <span className="muted">auto</span></>}{r.decisionComment && <div className="muted">{r.decisionComment}</div>}</> },
      { h: '', c: (r) => (r.status === 'pending' || (!decide && r.status === 'approved')) && (
        <>
          {decide && r.status === 'pending' && (
            <>
              <ActionForm inline path={`/leave/requests/${r.id}/approve`} back={back} ok="Leave approved" button="Approve" values={{ 'n:version': String(r.version) }} fields={[{ name: 's:comment', label: 'Comment (optional)' }]} />
              <Details summary="Reject"><ActionForm inline path={`/leave/requests/${r.id}/reject`} back={back} ok="Leave rejected" button="Reject" tone="danger" values={{ 'n:version': String(r.version) }} fields={[{ name: 's:comment', label: 'Reason' }]} /></Details>
            </>
          )}
          {!decide && <ActionButton path={`/leave/requests/${r.id}/cancel`} back={back} ok="Request cancelled" values={{ 'n:version': String(r.version) }} button="Cancel" confirm="Cancel this request?" />}
        </>
      ) },
    ]} empty="No leave requests." />
  );
}
