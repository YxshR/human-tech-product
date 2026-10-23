import type { ExceptionView, PayslipView, RunItemView, RunView } from '@humantech/contracts';
import { can, load, loadOr404, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, KV, Empty, Page, Pill, Table, Tabs, fmtDateTime, humanize, inr } from '@/components/ui';
import { runTone } from '@/lib/tones';

export const metadata = { title: 'Pay run' };
type Props = PageProps & { params: Promise<{ id: string }> };

export default async function RunPage({ params, searchParams }: Props) {
  const { id } = await params; const sp = await searchParams;
  const run = await loadOr404<RunView>(`/payroll/runs/${id}`);
  const tabs: Array<[string, string]> = [['summary', 'Summary'], ['exceptions', `Issues${run.openBlocking + run.openWarnings ? ` (${run.openBlocking + run.openWarnings})` : ''}`], ['items', 'People'], ['payslips', 'Payslips']];
  const tab = tabs.some(([k]) => k === sp.tab) ? sp.tab! : 'summary';
  const base = `/payroll/runs/${id}`; const back = `${base}?tab=${tab}`;
  return (
    <Page title={`Pay run ${run.periodCode}${run.revision > 1 ? ` · revision ${run.revision}` : ''}`} sub={humanize(run.runKind)} sp={sp} actions={<a className="btn" href="/payroll">← All pay runs</a>}>
      <Tabs base={base} current={tab} items={tabs} />
      {tab === 'summary' && <Summary run={run} back={back} />}
      {tab === 'exceptions' && <Exceptions run={run} back={back} />}
      {tab === 'items' && <Items run={run} />}
      {tab === 'payslips' && <Payslips run={run} />}
    </Page>
  );
}

async function Summary({ run, back }: { run: RunView; back: string }) {
  const [calc, submit, approve, finalize, correct, exportOk] = await Promise.all([can('payroll.calculate'), can('payroll.submit'), can('payroll.approve'), can('payroll.finalize'), can('payroll.correct'), can('payroll.export')]);
  const p = `/payroll/runs/${run.id}`; const s = run.status;
  return (
    <>
      <Card title="Status" wide>
        <KV items={[
          ['Status', <Pill key="s" tone={runTone(s)}>{humanize(s)}</Pill>], ['Payment', humanize(run.paymentStatus)], ['People', String(run.employeeCount)], ['Engine version', run.engineVersion ?? '—'],
          ['Gross pay', run.totals ? inr(run.totals.gross) : '—'], ['Employee deductions', run.totals ? inr(run.totals.employeeDeductions) : '—'], ['Employer contributions', run.totals ? inr(run.totals.employerContributions) : '—'], ['Net pay', run.totals ? inr(run.totals.netPay) : '—'],
          ['Submitted', run.submittedAt ? fmtDateTime(run.submittedAt) : '—'], ['Approved', run.approvedAt ? fmtDateTime(run.approvedAt) : '—'], ['Locked', run.lockedAt ? fmtDateTime(run.lockedAt) : '—'],
          ...(run.rejectionReason ? [['Rejected because', run.rejectionReason]] : []), ...(run.correctionReason ? [['Correction reason', run.correctionReason]] : []),
        ] as Array<[string, React.ReactNode]>} />
        {run.openBlocking > 0 && <p className="muted">{run.openBlocking} blocking issue(s) must be resolved before this run can move on.</p>}
      </Card>
      <Card title="Next step" wide>
        <div className="row">
          {calc && s === 'draft' && <ActionButton path={`${p}/validate`} back={back} ok="Checks complete" button="Run checks" tone="primary" />}
          {calc && (s === 'validated' || s === 'rejected') && <ActionButton path={`${p}/calculate`} back={back} ok="Pay calculated" button="Calculate pay" tone="primary" />}
          {calc && s === 'calculated' && <ActionButton path={`${p}/calculate`} back={back} ok="Pay recalculated" button="Recalculate" />}
          {calc && (s === 'calculated' || s === 'validated') && <ActionButton path={`${p}/reopen`} back={back} ok="Run reopened" button="Back to draft" />}
          {submit && s === 'calculated' && <ActionButton path={`${p}/submit`} back={back} ok="Sent for approval" button="Send for approval" tone="primary" confirm="Send this run for approval?" />}
          {approve && s === 'under_review' && <ActionButton path={`${p}/approve`} back={back} ok="Run approved" button="Approve" tone="primary" confirm="Approve this pay run? Someone else must then finalize it." />}
          {finalize && s === 'approved' && <ActionButton path={`${p}/finalize`} back={back} ok="Run finalized, payslips generated" button="Finalize and issue payslips" tone="primary" confirm="Finalizing locks the run and issues payslips. This cannot be undone." />}
          {exportOk && ['approved', 'locked', 'payslips_generated'].includes(s) && <a className="btn" href={`/dl/register/${run.id}`}>Download payroll register (CSV)</a>}
          {s === 'draft' && calc && <ActionButton path={`${p}/cancel`} back="/payroll" ok="Run cancelled" button="Cancel run" tone="danger" confirm="Cancel this run?" />}
        </div>
        {approve && s === 'under_review' && (
          <ActionForm path={`${p}/reject`} back={back} ok="Run sent back" button="Send back" tone="danger" fields={[{ name: 's:reason', label: 'Why is it being sent back?', kind: 'textarea', required: true }]} />
        )}
        {correct && (s === 'locked' || s === 'payslips_generated') && (
          <ActionForm path={`${p}/correct`} back={back} then="/payroll/runs/{id}" ok="Correction run started" button="Start a correction run" fields={[{ name: 's:reason', label: 'What needs correcting?', kind: 'textarea', required: true, hint: 'At least 10 characters. The original run stays unchanged.' }]} />
        )}
      </Card>
    </>
  );
}

async function Exceptions({ run, back }: { run: RunView; back: string }) {
  const rows = await load<ExceptionView[]>(`/payroll/runs/${run.id}/exceptions`);
  const resolve = await can('payroll.resolve_exception');
  if (rows === null) return <Empty>You cannot see these.</Empty>;
  if (rows.length === 0) return <Empty>No issues were found.</Empty>;
  return (
    <Card wide>
      <Table rows={rows} cols={[
        { h: 'Severity', c: (e) => <Pill tone={e.severity === 'blocking' ? 'bad' : 'warn'}>{e.severity}</Pill> }, { h: 'Who', c: (e) => e.employeeName ?? 'Whole run' }, { h: 'Issue', c: (e) => e.message },
        { h: 'Status', c: (e) => <><Pill tone={e.status === 'open' ? 'warn' : 'ok'}>{e.status}</Pill>{e.resolutionNote ? <div className="muted">{e.resolutionNote}</div> : null}</> },
        { h: '', c: (e) => resolve && e.status === 'open' && (
          <ActionForm inline method="PATCH" path={`/payroll/exceptions/${e.id}`} back={back} ok="Issue updated" button="Save" fields={[
            { name: 's:status', label: 'Outcome', kind: 'select', required: true, options: [['resolved', 'Resolved (fixed)'], ['waived', 'Waived (accepted)']] }, { name: 's:note', label: 'Note', required: true },
          ]} />
        ) },
      ]} empty="" />
    </Card>
  );
}

async function Items({ run }: { run: RunView }) {
  const rows = await load<RunItemView[]>(`/payroll/runs/${run.id}/items?limit=200`);
  if (rows === null) return <Empty>You cannot see these.</Empty>;
  return (
    <Card wide>
      <Table rows={rows} cols={[
        { h: 'Employee', c: (i) => <a href={`/payroll/runs/${run.id}/items/${i.id}`}>{i.employeeName} <span className="muted">{i.employeeNumber}</span></a> }, { h: 'Paid days', right: true, c: (i) => `${i.paidDays} / ${i.workingDays}` },
        { h: 'Gross', right: true, c: (i) => inr(i.grossEarnings) }, { h: 'Deductions', right: true, c: (i) => inr(i.employeeDeductions) }, { h: 'Net pay', right: true, c: (i) => inr(i.netPay) },
        { h: 'Status', c: (i) => <Pill tone={i.status === 'needs_review' ? 'warn' : i.status === 'excluded' ? 'bad' : undefined}>{humanize(i.status)}</Pill> },
      ]} empty="Nothing calculated yet." />
    </Card>
  );
}

async function Payslips({ run }: { run: RunView }) {
  const rows = await load<PayslipView[]>(`/payroll/runs/${run.id}/payslips`);
  if (rows === null) return <Empty>You cannot see these.</Empty>;
  return (
    <Card wide>
      <Table rows={rows} cols={[
        { h: 'Employee', c: (p) => <a href={`/payslips/${p.id}`}>{p.employeeName}</a> }, { h: 'Net pay', right: true, c: (p) => inr(p.netPay) }, { h: 'Issued', c: (p) => (p.issuedAt ? fmtDateTime(p.issuedAt) : '—') },
        { h: '', c: (p) => <a href={`/dl/payslip-any/${p.id}`}>PDF</a> },
      ]} empty="Payslips appear when the run is finalized." />
    </Card>
  );
}
