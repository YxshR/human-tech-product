import type { AdjustmentView, ComponentView, PayGroupView, PeriodView, RunView } from '@humantech/contracts';
import { can, employeeOptions, load, thisMonth, type PageProps } from '@/lib/data';
import { runTone } from '@/lib/tones';
import { ActionButton, ActionForm, Callout, Card, Empty, Page, Pill, Table, Tabs, fmtDate, fmtDateTime, humanize, inr, NoAccess } from '@/components/ui';

export const metadata = { title: 'Payroll' };
type Status = { activated: boolean; activatedAt: string | null; activationRequestedAt: string | null; makerCheckerRequired: boolean };


export default async function Payroll({ searchParams }: PageProps) {
  const sp = await searchParams;
  const status = await load<Status>('/payroll/status');
  const tabs: Array<[string, string]> = [['runs', 'Pay runs'], ['setup', 'Setup'], ['adjustments', 'Adjustments']];
  const tab = tabs.some(([k]) => k === sp.tab) ? sp.tab! : 'runs';
  const back = `/payroll?tab=${tab}`;
  return (
    <Page title="Payroll" sub="Pay everyone for a period in one pay run. One person prepares the run and a different person approves it." sp={sp}>
      {status === null ? <NoAccess what="payroll" /> : (
        <>
          {!status.activated && <Activation status={status} back={back} />}
          <Tabs base="/payroll" current={tab} items={tabs} />
          {tab === 'runs' && <Runs back={back} activated={status.activated} />}
          {tab === 'setup' && <Setup back={back} />}
          {tab === 'adjustments' && <Adjustments back={back} />}
        </>
      )}
    </Page>
  );
}

async function Activation({ status, back }: { status: Status; back: string }) {
  const manage = await can('payroll.manage_settings');
  return (
    <Callout tone="warn" title={status.activationRequestedAt ? 'Activation requested: waiting for the humanTech team' : 'Payroll is not switched on yet'}>
      {status.activationRequestedAt ? <p>You asked on {fmtDateTime(status.activationRequestedAt)}. We check your setup and switch payroll on; you will get a notification. Meanwhile you can keep preparing pay groups, structures and salaries.</p> : (
        <>
          <p>Pay runs are switched on by the humanTech team after checking your setup. Prepare first: (1) add a pay group and a period in Setup, (2) build a salary structure in Compensation, (3) give each employee a salary. Then request activation.</p>
          {manage && <div className="row"><ActionButton path="/payroll/activation-request" back={back} ok="Activation requested. We will notify you." button="Request activation" tone="primary" /></div>}
        </>
      )}
    </Callout>
  );
}

async function Runs({ back, activated }: { back: string; activated: boolean }) {
  const runs = await load<RunView[]>('/payroll/runs');
  const periods = ((await load<PeriodView[]>('/payroll/periods')) ?? []);
  const create = await can('payroll.create_run');
  if (runs === null) return <NoAccess what="pay runs" />;
  return (
    <>
      <Card wide>
        <Table rows={runs} cols={[
          { h: 'Period', c: (r) => <a href={`/payroll/runs/${r.id}`}><strong>{r.periodCode}</strong>{r.revision > 1 ? ` · revision ${r.revision}` : ''}</a> }, { h: 'Kind', c: (r) => humanize(r.runKind) },
          { h: 'Status', c: (r) => <Pill tone={runTone(r.status)}>{humanize(r.status)}</Pill> }, { h: 'People', right: true, c: (r) => r.employeeCount }, { h: 'Net pay', right: true, c: (r) => (r.totals ? inr(r.totals.netPay) : '—') },
          { h: 'Open issues', right: true, c: (r) => (r.openBlocking ? <Pill tone="bad">{r.openBlocking} blocking</Pill> : r.openWarnings ? <Pill tone="warn">{r.openWarnings} warnings</Pill> : '—') }, { h: 'Created', c: (r) => fmtDate(r.createdAt) },
        ]} empty={<Empty icon="rupee" title="No pay runs yet">{activated ? 'Start your first pay run below.' : 'Pay runs appear here once payroll is switched on.'}</Empty>} />
      </Card>
      {create && activated && (
        <Card title="Start a pay run" desc="Creates a draft for the period you choose. Nothing is paid or final until the run is approved and locked.">
          {periods.length === 0 ? <Empty>Generate a payroll period first (Setup tab).</Empty> : (
            <ActionForm path="/payroll/runs" back={back} ok="Pay run started" button="Start run" then="/payroll/runs/{id}" fields={[{ name: 's:payrollPeriodId', label: 'Period', kind: 'select', required: true, options: periods.filter((p) => p.status !== 'closed').map((p) => [p.id, `${p.periodCode} (${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)})${p.attendanceLockedAt ? '' : ' · attendance not locked'}`]) }]} />
          )}
          <Callout tone="plain"><p>Attendance for the period must be locked first: Attendance → Team → Lock attendance for payroll.</p></Callout>
        </Card>
      )}
    </>
  );
}

async function Setup({ back }: { back: string }) {
  const groups = await load<PayGroupView[]>('/payroll/pay-groups');
  const periods = await load<PeriodView[]>('/payroll/periods');
  const manage = await can('payroll.manage_settings');
  if (groups === null) return <NoAccess what="payroll setup" />;
  return (
    <>
      <Card title="Pay groups" desc="A pay group is a set of people paid on the same cycle, for example “Monthly staff”." wide>
        <Table rows={groups} cols={[
          { h: 'Code', c: (g) => g.code }, { h: 'Name', c: (g) => g.name }, { h: 'Period starts on day', right: true, c: (g) => g.periodStartDay }, { h: 'Days from', c: (g) => (g.attendanceSource === 'attendance' ? 'Attendance' : 'Everyone full pay') },
          { h: 'Pay day', right: true, c: (g) => g.payDay ?? '—' }, { h: 'Status', c: (g) => <Pill tone={g.status === 'active' ? 'ok' : undefined}>{g.status}</Pill> },
          { h: '', c: (g) => manage && <ActionButton method="PATCH" path={`/payroll/pay-groups/${g.id}`} back={back} ok="Pay group updated" values={{ 's:status': g.status === 'active' ? 'inactive' : 'active' }} button={g.status === 'active' ? 'Switch off' : 'Switch on'} /> },
        ]} empty="No pay groups yet." />
        {manage && (
          <ActionForm path="/payroll/pay-groups" back={back} ok="Pay group added" button="Add pay group" fields={[
            { name: 's:code', label: 'Code', required: true }, { name: 's:name', label: 'Name', required: true }, { name: 'n:periodStartDay', label: 'Period starts on day', kind: 'number', value: 1, min: 1, max: 28 },
            { name: 's:attendanceSource', label: 'Paid days come from', kind: 'select', required: true, value: 'attendance', options: [['attendance', 'Attendance'], ['full_pay', 'Everyone full pay']] }, { name: 'n:payDay', label: 'Pay day (optional)', kind: 'number', min: 1, max: 31 },
          ]} />
        )}
      </Card>
      <Card title="Payroll periods" desc="A period is one pay cycle for a pay group, for example November 2026. Generate it before starting a pay run." wide>
        <Table rows={periods ?? []} cols={[{ h: 'Period', c: (p) => p.periodCode }, { h: 'From', c: (p) => fmtDate(p.periodStart) }, { h: 'To', c: (p) => fmtDate(p.periodEnd) }, { h: 'Attendance', c: (p) => (p.attendanceLockedAt ? <Pill tone="ok">locked</Pill> : <Pill tone="warn">open</Pill>) }, { h: 'Status', c: (p) => humanize(p.status) }]} empty="No periods yet." />
        {manage && groups.length > 0 && (
          <ActionForm path="/payroll/periods/generate" back={back} ok="Period generated" button="Generate period" fields={[
            { name: 's:payGroupId', label: 'Pay group', kind: 'select', required: true, options: groups.filter((g) => g.status === 'active').map((g) => [g.id, g.name]) }, { name: 's:month', label: 'Month', kind: 'month', required: true, value: thisMonth() },
          ]} />
        )}
        <Callout tone="plain"><p>To put a person on a pay group, open them in Employees and go to the Salary tab.</p></Callout>
      </Card>
    </>
  );
}

async function Adjustments({ back }: { back: string }) {
  const rows = await load<AdjustmentView[]>('/payroll/adjustments');
  const manage = await can('payroll.manage_adjustments'); const approve = await can('payroll.approve_adjustment');
  const periods = manage ? ((await load<PeriodView[]>('/payroll/periods')) ?? []) : [];
  const components = manage ? ((await load<ComponentView[]>('/compensation/components')) ?? []).filter((c) => c.active && (c.componentType === 'earning' || c.componentType === 'employee_deduction')) : [];
  const people = manage ? await employeeOptions() : [];
  if (rows === null) return <NoAccess what="adjustments" />;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Employee', c: (a) => a.employeeName }, { h: 'Kind', c: (a) => humanize(a.kind) }, { h: 'Amount', right: true, c: (a) => inr(a.amount) }, { h: 'Why', c: (a) => a.reason }, { h: 'Source', c: (a) => humanize(a.source) },
          { h: 'Status', c: (a) => <Pill tone={a.status === 'approved' || a.status === 'applied' ? 'ok' : a.status === 'draft' ? 'warn' : undefined}>{a.status === 'draft' ? 'Waiting for approval' : humanize(a.status)}</Pill> },
          { h: '', c: (a) => a.status === 'draft' && (
            <>
              {approve && <><ActionButton path={`/payroll/adjustments/${a.id}/approve`} back={back} ok="Adjustment approved" button="Approve" /><ActionButton path={`/payroll/adjustments/${a.id}/reject`} back={back} ok="Adjustment rejected" button="Reject" tone="danger" /></>}
              {manage && <ActionButton path={`/payroll/adjustments/${a.id}/cancel`} back={back} ok="Adjustment cancelled" button="Cancel" />}
            </>
          ) },
        ]} empty="No adjustments." />
        <p className="muted">A second person approves each adjustment. Approved adjustments are picked up by the next calculation of that period.</p>
      </Card>
      {manage && (
        <Card title="Add an adjustment" desc="A one-off amount added to or taken from one person's pay in one period, such as a bonus or a recovery.">
          <ActionForm path="/payroll/adjustments" back={back} ok="Adjustment submitted for approval" button="Submit" fields={[
            { name: 's:employeeId', label: 'Employee', kind: 'select', required: true, options: people }, { name: 's:payrollPeriodId', label: 'Period', kind: 'select', required: true, options: periods.filter((p) => p.status !== 'closed').map((p) => [p.id, p.periodCode]) },
            { name: 's:componentId', label: 'Pay component', kind: 'select', required: true, options: components.map((c) => [c.id, `${c.code} · ${c.label}`]) }, { name: 's:kind', label: 'Adds or deducts', kind: 'select', required: true, options: [['earning', 'Adds to pay'], ['deduction', 'Deducts from pay']] },
            { name: 's:amount', label: 'Amount (₹)', required: true, hint: 'Positive, e.g. 1500.00' }, { name: 's:reason', label: 'Reason', required: true }, { name: 's:source', label: 'Type', kind: 'select', required: true, value: 'manual', options: [['manual', 'One-off'], ['arrears', 'Arrears'], ['correction', 'Correction']] },
          ]} />
        </Card>
      )}
    </>
  );
}
