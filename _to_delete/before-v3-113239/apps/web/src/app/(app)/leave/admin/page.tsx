import { ACCRUAL_FREQUENCIES, type LeavePolicyView, type LeaveTypeView } from '@humantech/contracts';
import { load, today, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, Page, Pill, Table, Tabs, fmtDate, humanize } from '@/components/ui';

export const metadata = { title: 'Leave policy' };
const TABS: Array<[string, string]> = [['types', 'Leave types'], ['policies', 'Policies'], ['runs', 'Accrual & year end']];

export default async function LeaveAdmin({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'types';
  const back = `/leave/admin?tab=${tab}`;
  const types = await load<LeaveTypeView[]>('/leave/types', { includeInactive: 'true' });
  return (
    <Page title="Leave policy" sub="What kinds of leave exist and how balances build up" sp={sp}>
      <Tabs base="/leave/admin" current={tab} items={TABS} />
      {types === null ? <Empty>You do not have access to leave policy.</Empty> : tab === 'types' ? <Types types={types} back={back} /> : tab === 'policies' ? <Policies types={types} back={back} /> : <Runs back={back} />}
    </Page>
  );
}

function Types({ types, back }: { types: LeaveTypeView[]; back: string }) {
  return (
    <>
      <Card wide>
        <Table rows={types} cols={[
          { h: 'Code', c: (t) => t.code }, { h: 'Name', c: (t) => t.name }, { h: 'Paid', c: (t) => (t.isPaid ? 'Yes' : 'No') }, { h: 'Needs approval', c: (t) => (t.requiresApproval ? 'Yes' : 'No') },
          { h: 'Half days', c: (t) => (t.allowHalfDay ? 'Yes' : 'No') }, { h: 'May go negative by', right: true, c: (t) => t.maxNegativeDays }, { h: 'Status', c: (t) => <Pill tone={t.active ? 'ok' : undefined}>{t.active ? 'active' : 'inactive'}</Pill> },
          { h: '', c: (t) => <ActionButton method="PATCH" path={`/leave/types/${t.id}`} back={back} ok={t.active ? 'Leave type switched off' : 'Leave type switched on'} values={{ 'b:active': t.active ? 'false' : 'true' }} button={t.active ? 'Switch off' : 'Switch on'} /> },
        ]} empty="No leave types yet." />
      </Card>
      <Card title="Add a leave type">
        <ActionForm path="/leave/types" back={back} ok="Leave type added" button="Add" fields={[
          { name: 's:code', label: 'Code', required: true, hint: 'e.g. CL' }, { name: 's:name', label: 'Name', required: true, hint: 'e.g. Casual leave' },
          { name: 'b:isPaid', label: 'Paid leave', kind: 'checkbox', value: true }, { name: 'b:requiresApproval', label: 'Needs approval', kind: 'checkbox', value: true }, { name: 'b:allowHalfDay', label: 'Allow half days', kind: 'checkbox', value: true },
          { name: 's:maxNegativeDays', label: 'May go negative by (days)', value: '0' },
        ]} />
      </Card>
    </>
  );
}

function Policies({ types, back }: { types: LeaveTypeView[]; back: string }) {
  return <PolicyList types={types} back={back} />;
}
async function PolicyList({ types, back }: { types: LeaveTypeView[]; back: string }) {
  const policies = (await load<LeavePolicyView[]>('/leave/policies')) ?? [];
  return (
    <>
      <Card wide>
        <Table rows={policies} cols={[
          { h: 'Leave type', c: (p) => types.find((t) => t.id === p.leaveTypeId)?.name ?? '—' }, { h: 'Version', right: true, c: (p) => p.version }, { h: 'From', c: (p) => fmtDate(p.effectiveFrom) }, { h: 'To', c: (p) => fmtDate(p.effectiveTo) },
          { h: 'Accrues', c: (p) => `${p.accrualDays} days ${humanize(p.accrualFrequency)}` }, { h: 'Carry forward', right: true, c: (p) => p.carryForwardMaxDays },
          { h: 'Status', c: (p) => <Pill tone={p.status === 'active' ? 'ok' : p.status === 'draft' ? 'warn' : undefined}>{p.status}</Pill> },
          { h: '', c: (p) => (p.status === 'draft' ? <ActionButton path={`/leave/policies/${p.id}/activate`} back={back} ok="Policy active" button="Activate" /> : p.status === 'active' ? <ActionButton path={`/leave/policies/${p.id}/retire`} back={back} ok="Policy retired" button="Retire" tone="danger" confirm="Retire this policy? Balances already built up are kept." /> : null) },
        ]} empty="No policies yet. Add one below, then activate it." />
      </Card>
      <Card title="Add a policy">
        <p className="muted">New policies start as drafts and take effect once activated. Two active policies for the same leave type cannot cover the same dates, so retire (or set an end date on) the old one first.</p>
        <ActionForm path="/leave/policies" back={back} ok="Policy added as a draft" button="Add policy" fields={[
          { name: 's:leaveTypeId', label: 'Leave type', kind: 'select', required: true, options: types.filter((t) => t.active).map((t) => [t.id, t.name]) },
          { name: 'd:effectiveFrom', label: 'Effective from', kind: 'date', required: true, value: today() }, { name: 'd:effectiveTo', label: 'Effective to', kind: 'date' },
          { name: 's:accrualFrequency', label: 'Accrual', kind: 'select', required: true, value: 'monthly', options: ACCRUAL_FREQUENCIES.map((f) => [f, humanize(f)]) }, { name: 's:accrualDays', label: 'Days per accrual', required: true, value: '1' },
          { name: 'n:eligibleAfterDays', label: 'Eligible after (days of service)', kind: 'number', value: 0, min: 0 }, { name: 'b:probationEligible', label: 'Employees on probation may use it', kind: 'checkbox', value: true },
          { name: 's:carryForwardMaxDays', label: 'Carry forward up to (days)', value: '0' }, { name: 'b:countWeeklyOffs', label: 'Weekly offs inside a leave count as leave', kind: 'checkbox' }, { name: 'b:countHolidays', label: 'Holidays inside a leave count as leave', kind: 'checkbox' },
        ]} />
      </Card>
    </>
  );
}

function Runs({ back }: { back: string }) {
  return (
    <div className="grid2">
      <Card title="Run accrual now" wide>
        <p className="muted">Normally this runs by itself every night. Run it by hand after changing a policy or joining dates.</p>
        <ActionForm path="/leave/accrual/run" back={back} ok="Accrual finished" button="Run accrual" fields={[{ name: 'd:asOf', label: 'As of (optional)', kind: 'date' }]} />
      </Card>
      <Card title="Year end" wide>
        <p className="muted">Applies the carry-forward limits and expires the rest for a calendar year. It is safe to run twice.</p>
        <ActionForm path="/leave/year-end/run" back={back} ok="Year-end finished" button="Run year end" fields={[{ name: 'n:year', label: 'Year', kind: 'number', required: true, value: new Date().getFullYear() - 1, min: 2000, max: 2100 }]} confirm="Run year end for this year?" />
      </Card>
    </div>
  );
}
