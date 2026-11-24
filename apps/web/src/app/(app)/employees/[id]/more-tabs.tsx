import type { PayGroupView, AssignmentView, LeaveBalanceView, LeaveLedgerEntry, LeaveTypeView, StructureView } from '@humantech/contracts';
import { can, load, today } from '@/lib/data';
import { ActionButton, ActionForm, Card, Details, Empty, Pill, Table, dash, fmtDate, humanize, inr, NoAccess } from '@/components/ui';

export async function SalaryTab({ id, back }: { id: string; back: string }) {
  const rows = await load<AssignmentView[]>('/compensation/assignments', { employeeId: id });
  const assign = await can('salary.assign'); const approve = await can('salary.approve_assignment');
  const structures = assign ? ((await load<StructureView[]>('/compensation/structures')) ?? []).filter((s) => s.status === 'active') : [];
  if (rows === null) return <NoAccess what="salary details" />;
  const paySetup = await can('payroll.manage_settings');
  const groups = paySetup ? ((await load<PayGroupView[]>('/payroll/pay-groups')) ?? []).filter((g) => g.status === 'active') : [];
  return (
    <>
      <Card title="Salary history" desc="Every salary this person has had. A change takes effect only after a second person approves it; you cannot approve your own proposal." wide>
        <Table rows={rows} cols={[
          { h: 'From', c: (a) => fmtDate(a.effectiveFrom) }, { h: 'To', c: (a) => fmtDate(a.effectiveTo) }, { h: 'Structure', c: (a) => a.structureCode }, { h: 'Monthly CTC', right: true, c: (a) => inr(a.monthlyCtc) },
          { h: 'Reason', c: (a) => a.changeReason }, { h: 'Status', c: (a) => <Pill tone={a.approvalStatus === 'approved' ? 'ok' : a.approvalStatus === 'pending' ? 'warn' : 'bad'}>{a.approvalStatus === 'pending' ? 'Waiting for approval' : a.approvalStatus}</Pill> },
          { h: '', c: (a) => approve && a.approvalStatus === 'pending' && (
            <>
              <ActionButton path={`/compensation/assignments/${a.id}/approve`} back={back} ok="Salary approved" button="Approve" tone="primary" confirm="Approve this salary? It will be used in pay runs from its start date." />
              <ActionButton path={`/compensation/assignments/${a.id}/reject`} back={back} ok="Salary change rejected" button="Reject" tone="danger" confirm="Reject this salary proposal?" />
            </>
          ) },
        ]} empty={<Empty icon="rupee" title="No salary yet">{assign ? 'Propose one below. It applies once a second person approves it.' : 'A salary has not been set for this person.'}</Empty>} />
      </Card>
      {assign && (
        <Card title="Propose a salary" desc="Goes to an approver. Until it is approved, the current salary stays in force.">
          {structures.length === 0 ? <Empty icon="layers" title="Create a salary structure first" action={<a className="btn primary" href="/compensation?tab=structures">Go to Compensation</a>}>A structure says how a monthly amount is split into basic, allowances and deductions. Create and activate one, then come back.</Empty> : (
            <ActionForm path="/compensation/assignments" back={back} ok="Salary proposed; waiting for approval" button="Send for approval" values={{ 's:employeeId': id }} fields={[
              { name: 's:salaryStructureId', label: 'Structure', kind: 'select', required: true, options: structures.map((s) => [s.id, `${s.name} (${s.code} v${s.version})`]) },
              { name: 'd:effectiveFrom', label: 'Effective from', kind: 'date', required: true, value: today() }, { name: 'd:monthlyCtc', label: 'Monthly CTC (₹)', required: true, placeholder: '50000.00', hint: 'Total monthly cost to the company, in rupees' },
              { name: 's:changeReason', label: 'Reason', required: true, placeholder: 'e.g. Joining salary, annual increment', hint: 'The approver sees this' },
            ]} />
          )}
        </Card>
      )}
      {paySetup && (
        <Card title="Payroll setup" desc="Which pay cycle this person is paid in, and whether pay runs include them.">
          <ActionForm method="PUT" path={`/payroll/employees/${id}/pay-setup`} back={back} ok="Payroll setup saved" button="Save" fields={[
            { name: 'z:payGroupId', label: 'Pay group', kind: 'select', placeholder: 'Not on a pay group', options: groups.map((g) => [g.id, g.name]), hint: 'Without a pay group this person is not paid through payroll' },
            { name: 'b:payrollEligible', label: 'Included in payroll runs', kind: 'checkbox', value: true },
          ]} />
        </Card>
      )}
    </>
  );
}

export async function LeaveTab({ id, back }: { id: string; back: string }) {
  const balances = await load<LeaveBalanceView[]>('/leave/balances', { employeeId: id });
  const adjust = await can('leave.adjust_balance');
  const types = adjust ? ((await load<LeaveTypeView[]>('/leave/types')) ?? []).filter((t) => t.active) : [];
  if (balances === null) return <NoAccess what={"this person's leave"} />;
  return (
    <>
      <Card title="Leave balances" desc="Available = balance minus requests waiting for a decision. Open History to see how a balance was built." wide>
        <Table rows={balances} cols={[{ h: 'Leave type', c: (b) => b.leaveTypeName }, { h: 'Balance', right: true, c: (b) => b.balanceDays }, { h: 'Waiting', right: true, c: (b) => b.pendingDays }, { h: 'Available', right: true, c: (b) => <strong>{b.availableDays}</strong> },
          { h: '', c: (b) => <Details summary="History"><Ledger employeeId={id} leaveTypeId={b.leaveTypeId} /></Details> }]} empty="No leave balances yet." />
      </Card>
      {adjust && (
        <Card title="Adjust a balance" desc="Add or remove days by hand, for example an opening balance or a correction. The reason is kept in the history.">
          <ActionForm path="/leave/balances/adjust" back={back} ok="Balance adjusted" button="Adjust balance" values={{ 's:employeeId': id }} fields={[
            { name: 's:leaveTypeId', label: 'Leave type', kind: 'select', required: true, options: types.map((t) => [t.id, t.name]) },
            { name: 's:days', label: 'Days to add', required: true, placeholder: '2', hint: 'Use a minus sign to take days away, e.g. -1.5' }, { name: 'd:effectiveDate', label: 'Effective date', kind: 'date', required: true, value: today() },
            { name: 's:kind', label: 'Kind', kind: 'select', required: true, value: 'manual_adjustment', options: [['manual_adjustment', 'Adjustment'], ['opening_grant', 'Opening balance']] }, { name: 's:reason', label: 'Reason', required: true },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Ledger({ employeeId, leaveTypeId }: { employeeId: string; leaveTypeId: string }) {
  const rows = await load<LeaveLedgerEntry[]>('/leave/balances/ledger', { employeeId, leaveTypeId });
  if (!rows) return <Empty>No history.</Empty>;
  return <Table rows={rows} cols={[{ h: 'Date', c: (r) => fmtDate(r.effectiveDate) }, { h: 'What', c: (r) => humanize(r.transactionType) }, { h: 'Days', right: true, c: (r) => r.daysDelta }, { h: 'Note', c: (r) => dash(r.reason) }]} empty="No history." />;
}
