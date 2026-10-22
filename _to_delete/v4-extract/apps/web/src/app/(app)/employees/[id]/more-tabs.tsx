import type { PayGroupView, AssignmentView, LeaveBalanceView, LeaveLedgerEntry, LeaveTypeView, StructureView } from '@humantech/contracts';
import { can, load, today } from '@/lib/data';
import { ActionButton, ActionForm, Card, Details, Empty, Pill, Table, dash, fmtDate, humanize, inr } from '@/components/ui';

export async function SalaryTab({ id, back }: { id: string; back: string }) {
  const rows = await load<AssignmentView[]>('/compensation/assignments', { employeeId: id });
  const assign = await can('salary.assign'); const approve = await can('salary.approve_assignment');
  const structures = assign ? ((await load<StructureView[]>('/compensation/structures')) ?? []).filter((s) => s.status === 'active') : [];
  if (rows === null) return <Empty>You do not have access to salary details.</Empty>;
  const paySetup = await can('payroll.manage_settings');
  const groups = paySetup ? ((await load<PayGroupView[]>('/payroll/pay-groups')) ?? []).filter((g) => g.status === 'active') : [];
  return (
    <>
      <Card title="Salary history" wide>
        <Table rows={rows} cols={[
          { h: 'From', c: (a) => fmtDate(a.effectiveFrom) }, { h: 'To', c: (a) => fmtDate(a.effectiveTo) }, { h: 'Structure', c: (a) => a.structureCode }, { h: 'Monthly CTC', right: true, c: (a) => inr(a.monthlyCtc) },
          { h: 'Why', c: (a) => a.changeReason }, { h: 'Status', c: (a) => <Pill tone={a.approvalStatus === 'approved' ? 'ok' : a.approvalStatus === 'pending' ? 'warn' : 'bad'}>{a.approvalStatus}</Pill> },
          { h: '', c: (a) => approve && a.approvalStatus === 'pending' && (
            <>
              <ActionButton path={`/compensation/assignments/${a.id}/approve`} back={back} ok="Salary approved" button="Approve" />
              <ActionButton path={`/compensation/assignments/${a.id}/reject`} back={back} ok="Salary change rejected" button="Reject" tone="danger" />
            </>
          ) },
        ]} empty="No salary on record." />
        <p className="muted">A second person approves every salary change. You cannot approve a change you proposed.</p>
      </Card>
      {assign && (
        <Card title="Propose a salary">
          {structures.length === 0 ? <Empty>Create and activate a salary structure first (Compensation → Structures).</Empty> : (
            <ActionForm path="/compensation/assignments" back={back} ok="Salary proposed; waiting for approval" button="Propose" values={{ 's:employeeId': id }} fields={[
              { name: 's:salaryStructureId', label: 'Structure', kind: 'select', required: true, options: structures.map((s) => [s.id, `${s.name} (${s.code} v${s.version})`]) },
              { name: 'd:effectiveFrom', label: 'Effective from', kind: 'date', required: true, value: today() }, { name: 'd:monthlyCtc', label: 'Monthly CTC (₹)', required: true, hint: 'e.g. 50000.00' },
              { name: 's:changeReason', label: 'Reason', required: true, hint: 'Shown to the approver' },
            ]} />
          )}
        </Card>
      )}
      {paySetup && (
        <Card title="Payroll setup">
          <ActionForm method="PUT" path={`/payroll/employees/${id}/pay-setup`} back={back} ok="Payroll setup saved" button="Save" fields={[
            { name: 'z:payGroupId', label: 'Pay group', kind: 'select', options: groups.map((g) => [g.id, g.name]), hint: 'Leave empty to take this person off payroll' },
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
  if (balances === null) return <Empty>You do not have access to this person&apos;s leave.</Empty>;
  return (
    <>
      <Card title="Balances" wide>
        <Table rows={balances} cols={[{ h: 'Leave type', c: (b) => b.leaveTypeName }, { h: 'Balance', right: true, c: (b) => b.balanceDays }, { h: 'Pending', right: true, c: (b) => b.pendingDays }, { h: 'Available', right: true, c: (b) => b.availableDays },
          { h: '', c: (b) => <Details summary="History"><Ledger employeeId={id} leaveTypeId={b.leaveTypeId} /></Details> }]} empty="No leave balances yet." />
      </Card>
      {adjust && (
        <Card title="Adjust a balance">
          <ActionForm path="/leave/balances/adjust" back={back} ok="Balance adjusted" button="Adjust" values={{ 's:employeeId': id }} fields={[
            { name: 's:leaveTypeId', label: 'Leave type', kind: 'select', required: true, options: types.map((t) => [t.id, t.name]) },
            { name: 's:days', label: 'Days (negative to deduct)', required: true, hint: 'e.g. 2 or -1.5' }, { name: 'd:effectiveDate', label: 'Effective date', kind: 'date', required: true, value: today() },
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
