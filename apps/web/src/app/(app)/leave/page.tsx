import type { LeaveBalanceView, LeaveRequestView, LeaveTypeView } from '@humantech/contracts';
import { can, load, loadPaged, today, type PageProps } from '@/lib/data';
import Link from 'next/link';
import { ActionButton, ActionForm, Card, Details, Empty, Page, Pager, Pill, Table, Tabs, Tiles, fmtDate, humanize, NoAccess } from '@/components/ui';

export const metadata = { title: 'Leave' };
const TABS: Array<[string, string]> = [['mine', 'My leave'], ['approvals', 'Requests to decide']];


export default async function Leave({ searchParams }: PageProps) {
  const sp = await searchParams;
  const approver = await can('leave.approve', 'leave.reject');
  const tabs = approver ? TABS : TABS.slice(0, 1);
  const tab = tabs.some(([k]) => k === sp.tab) ? sp.tab! : 'mine';
  const back = `/leave?tab=${tab}`;
  return (
    <Page title="Leave" sub={tab === 'mine' ? 'See how much leave you have, ask for time off and follow your requests.' : 'Leave requests from people you approve for. Approving takes the days off their balance.'} sp={sp}>
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
        <Card title="Leave you can take" desc="Available = your balance minus requests still waiting for a decision." wide>
          {balances === null ? <Empty icon="calendar" title="No leave balance for this sign-in">Leave balances belong to employee records, and this sign-in is not linked to one. Ask HR to link it if you should have leave.</Empty>
            : balances.length === 0 ? <Empty icon="calendar" title="No leave set up yet">Your company has not given you any leave types yet. HR sets these up in Leave policy.</Empty> : (
              <>
                <Tiles items={balances.map((b) => ({ label: `${b.leaveTypeName} · days available`, value: b.availableDays, tone: 'strong' as const }))} />
                <div style={{ marginTop: 14 }}><Table caption="Leave balances" rows={balances} cols={[{ h: 'Leave type', c: (b) => b.leaveTypeName }, { h: 'Balance', right: true, c: (b) => b.balanceDays }, { h: 'Waiting', right: true, c: (b) => b.pendingDays }, { h: 'Available', right: true, c: (b) => <strong>{b.availableDays}</strong> }]} /></div>
              </>
            )}
        </Card>
        {apply && types.length > 0 && balances !== null && (
          <Card title="Ask for time off" desc="Your approver is notified. You can cancel a request any time before the leave starts." wide>
            <ActionForm cols path="/leave/requests" back={back} ok="Leave request sent to your approver" button="Send request" fields={[
              { name: 's:leaveTypeId', label: 'Leave type', kind: 'select', required: true, options: types.map((t) => [t.id, `${t.name}${t.isPaid ? '' : ' (unpaid)'}`]) },
              { name: 'z:partialDay', label: 'Full or half day', kind: 'select', placeholder: 'Full day(s)', options: [['first_half', 'Half day: first half'], ['second_half', 'Half day: second half']], hint: 'A half day needs the same From and To date' },
              { name: 'd:startDate', label: 'First day off', kind: 'date', required: true, value: today() }, { name: 'd:endDate', label: 'Last day off', kind: 'date', required: true, value: today(), hint: 'Same as the first day for a single day' },
              { name: 'z:reason', label: 'Reason', kind: 'textarea', placeholder: 'Optional. Your approver sees this.' },
            ]} />
          </Card>
        )}
      </div>
      <Card title="My requests" desc="Everything you have asked for, newest first." wide>
        {requests === null ? <Empty icon="calendar">Requests appear here once your sign-in is linked to an employee record.</Empty> : <RequestTable rows={requests.rows} back={back} decide={false} />}
        <Pager base="/leave" query={{ tab: 'mine', status: sp.status }} nextCursor={requests?.next ?? null} started={!!sp.cursor} />
      </Card>
    </>
  );
}

async function Approvals({ back, sp }: { back: string; sp: { cursor?: string } }) {
  const pending = await loadPaged<LeaveRequestView>('/leave/requests', { status: 'pending', cursor: sp.cursor, limit: '25' });
  if (pending === null) return <NoAccess what="approvals" />;
  return (
    <Card wide>
      <RequestTable rows={pending.rows} back={back} decide />
      <Pager base="/leave" query={{ tab: 'approvals' }} nextCursor={pending.next} started={!!sp.cursor} />
    </Card>
  );
}

function RequestTable({ rows, back, decide }: { rows: LeaveRequestView[]; back: string; decide: boolean }) {
  return (
    <Table rows={rows} cols={[
      ...(decide ? [{ h: 'Who', c: (r: LeaveRequestView) => <><Link href={`/employees/${r.employeeId}?tab=leave`}><strong>{r.employeeName}</strong></Link><div className="muted">{r.employeeNumber}</div></> }] : []), { h: 'Leave type', c: (r) => r.leaveTypeCode },
      { h: 'Dates', c: (r) => `${fmtDate(r.startDate)}${r.endDate !== r.startDate ? ` – ${fmtDate(r.endDate)}` : ''}${r.partialDay ? ` (${humanize(r.partialDay)})` : ''}` },
      { h: 'Days', right: true, c: (r) => r.requestedDays }, { h: 'Reason', c: (r) => r.reason ?? <span className="muted">None given</span> },
      { h: 'Status', c: (r) => <><Pill>{r.status === 'pending' ? 'Waiting' : r.status}</Pill>{r.autoApproved && <div className="muted">Approved automatically</div>}{r.decisionComment && <div className="muted">“{r.decisionComment}”</div>}</> },
      { h: '', c: (r) => (r.status === 'pending' || (!decide && r.status === 'approved')) && (
        <>
          {decide && r.status === 'pending' && (
            <>
              <ActionForm inline path={`/leave/requests/${r.id}/approve`} back={back} ok={`Leave approved for ${r.employeeName}`} button="Approve" tone="primary" values={{ 'n:version': String(r.version) }} />
              <Details summary="Reject"><ActionForm path={`/leave/requests/${r.id}/reject`} back={back} ok={`Leave rejected for ${r.employeeName}`} button="Reject request" tone="danger" values={{ 'n:version': String(r.version) }} fields={[{ name: 's:comment', label: 'Reason (the employee sees this)' }]} /></Details>
            </>
          )}
          {!decide && <ActionButton path={`/leave/requests/${r.id}/cancel`} back={back} ok="Request cancelled" values={{ 'n:version': String(r.version) }} button="Cancel request" confirm={r.status === 'approved' ? 'Cancel this approved leave? The days go back to your balance.' : 'Cancel this leave request?'} />}
        </>
      ) },
    ]} empty={<Empty icon="calendar" title={decide ? 'Nothing waiting for you' : 'No requests yet'}>{decide ? 'When someone you approve for asks for leave, it appears here.' : 'When you ask for time off, you can follow it here.'}</Empty>} />
  );
}
