import { ACTIVITY_TYPES, CANDIDATE_STAGES, EMPLOYMENT_TYPES, type ActivityView, type BranchView, type CandidateView, type StageHistoryView } from '@humantech/contracts';
import { CustomTab } from '../../../employees/[id]/custom-tab';
import { can, load, loadOr404, options, today, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, KV, Page, Pill, Table, Tabs, dash, fmtDateTime, humanize, inr } from '@/components/ui';

export const metadata = { title: 'Candidate' };
const TABS: Array<[string, string]> = [['overview', 'Overview'], ['activity', 'Activity'], ['history', 'Stage history'], ['custom', 'Custom fields']];

export default async function CandidatePage({ params, searchParams }: PageProps<{ id: string }>) {
  const { id } = await params; const sp = await searchParams;
  const c = await loadOr404<CandidateView>(`/candidates/${id}`);
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'overview';
  const base = `/recruitment/candidates/${id}`; const back = `${base}?tab=${tab}`;
  return (
    <Page title={`${c.firstName} ${c.lastName ?? ''}`.trim()} sub={`${c.candidateCode}${c.roleTitle ? ` · ${c.roleTitle}` : ''}`} sp={sp}
      actions={<><a className="btn" href="/recruitment">← Candidates</a><Pill tone={c.archived ? 'bad' : undefined}>{c.archived ? 'Archived' : humanize(c.stage)}</Pill></>}>
      <Tabs base={base} current={tab} items={TABS} />
      {tab === 'overview' && <Overview c={c} back={back} />}
      {tab === 'activity' && <Activity c={c} back={back} />}
      {tab === 'history' && <History c={c} />}
      {tab === 'custom' && <CustomTab kind="candidates" id={id} back={back} />}
    </Page>
  );
}

async function Overview({ c, back }: { c: CandidateView; back: string }) {
  const [update, stage, salary, convert] = await Promise.all([can('candidate.update'), can('candidate.change_stage'), can('candidate.read_salary'), can('candidate.convert')]);
  const branches = convert ? ((await load<BranchView[]>('/branches')) ?? []) : [];
  const p = `/candidates/${c.id}`;
  return (
    <>
      <Card title="Details" wide>
        <KV items={[
          ['Email', dash(c.email)], ['Phone', dash(c.phone)], ['City', dash(c.city)], ['Source', dash(c.source)],
          ['Experience', c.totalExperienceMonths === null ? '—' : `${Math.floor(c.totalExperienceMonths / 12)}y ${c.totalExperienceMonths % 12}m`], ['Notice period', c.noticePeriodDays === null ? '—' : `${c.noticePeriodDays} days`],
          ['Next follow-up', c.nextFollowUpAt ? fmtDateTime(c.nextFollowUpAt) : '—'], ['Tags', c.tags.join(', ') || '—'],
          ...(c.currentCtc !== undefined ? [['Current CTC (yearly)', c.currentCtc ? inr(c.currentCtc) : '—'] as [string, string], ['Expected CTC (yearly)', c.expectedCtc ? inr(c.expectedCtc) : '—'] as [string, string]] : []),
          ...(c.closureReason ? [['Closed because', c.closureReason] as [string, string]] : []),
        ]} />
        {c.convertedEmployeeId && <p><a href={`/employees/${c.convertedEmployeeId}`}>Open the employee record →</a></p>}
      </Card>
      {stage && !c.archived && !c.convertedEmployeeId && (
        <Card title="Move to a stage">
          <ActionForm path={`${p}/stage`} back={back} ok="Stage changed" button="Move" fields={[
            { name: 's:stage', label: 'Stage', kind: 'select', required: true, value: c.stage, options: CANDIDATE_STAGES.filter((s) => s !== 'joined').map((s) => [s, humanize(s)]) },
            { name: 's:reason', label: 'Reason (needed for rejected / withdrawn)' },
          ]} />
          <p className="muted">Candidates become &ldquo;joined&rdquo; by converting them to employees.</p>
        </Card>
      )}
      {update && !c.archived && (
        <Card title="Edit">
          <ActionForm method="PATCH" path={p} back={back} ok="Candidate updated" button="Save" values={{ 'n:version': String(c.version) }} fields={[
            { name: 's:firstName', label: 'First name', value: c.firstName, required: true }, { name: 's:lastName', label: 'Last name', value: c.lastName ?? '' }, { name: 'z:email', label: 'Email', kind: 'email', value: c.email ?? '' }, { name: 'z:phone', label: 'Phone', kind: 'tel', value: c.phone ?? '' },
            { name: 's:city', label: 'City', value: c.city ?? '' }, { name: 's:roleTitle', label: 'Role', value: c.roleTitle ?? '' }, { name: 'n:noticePeriodDays', label: 'Notice period (days)', kind: 'number', value: c.noticePeriodDays },
            { name: 'd:availableFrom', label: 'Available from', kind: 'date', value: c.availableFrom },
          ]} />
        </Card>
      )}
      {salary && !c.archived && (
        <Card title="Compensation (yearly ₹)">
          <ActionForm method="PUT" path={`${p}/compensation`} back={back} ok="Compensation saved" button="Save" fields={[
            { name: 'z:currentCtc', label: 'Current CTC', value: c.currentCtc ?? '', hint: 'e.g. 600000.00' }, { name: 'z:expectedCtc', label: 'Expected CTC', value: c.expectedCtc ?? '' },
          ]} />
        </Card>
      )}
      {convert && c.stage === 'selected_offer' && !c.convertedEmployeeId && !c.archived && (
        <Card title="Convert to employee">
          <ActionForm path={`${p}/convert`} back={back} then="/employees/{id}" ok="Employee created from candidate" button="Convert" confirm="Create an employee record from this candidate?" fields={[
            { name: 's:branchId', label: 'Branch', kind: 'select', required: true, options: options(branches, (b) => b.id, (b) => b.name) }, { name: 's:employmentType', label: 'Employment type', kind: 'select', required: true, value: 'full_time', options: EMPLOYMENT_TYPES.map((t) => [t, humanize(t)]) },
            { name: 'd:joinedAt', label: 'Joining date', kind: 'date', required: true, value: today() }, { name: 's:workEmail', label: 'Work email', kind: 'email' },
          ]} />
        </Card>
      )}
      {update && !c.convertedEmployeeId && (
        <Card title={c.archived ? 'Restore' : 'Archive'}>
          <ActionButton path={`${p}/${c.archived ? 'restore' : 'archive'}`} back={back} ok={c.archived ? 'Candidate restored' : 'Candidate archived'} button={c.archived ? 'Restore candidate' : 'Archive candidate'} tone={c.archived ? undefined : 'danger'} />
        </Card>
      )}
    </>
  );
}

async function Activity({ c, back }: { c: CandidateView; back: string }) {
  const rows = await load<ActivityView[]>(`/candidates/${c.id}/activities`);
  const update = await can('candidate.update');
  if (rows === null) return <Empty>You do not have access.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'When', c: (a) => fmtDateTime(a.createdAt) }, { h: 'Type', c: (a) => humanize(a.type) }, { h: 'Note', c: (a) => a.body },
          { h: 'Follow-up', c: (a) => (a.dueAt ? <>{fmtDateTime(a.dueAt)} {a.completedAt ? <Pill tone="ok">done</Pill> : <Pill tone="warn">open</Pill>}</> : '') },
          { h: '', c: (a) => update && a.type === 'follow_up' && !a.completedAt && <ActionButton path={`/candidate-activities/${a.id}/complete`} back={back} ok="Follow-up completed" button="Complete" /> },
        ]} empty="No activity yet." />
      </Card>
      {update && !c.archived && (
        <Card title="Log activity">
          <ActionForm path={`/candidates/${c.id}/activities`} back={back} ok="Activity added" button="Add" fields={[
            { name: 's:type', label: 'Type', kind: 'select', required: true, value: 'note', options: ACTIVITY_TYPES.map((t) => [t, humanize(t)]) }, { name: 's:body', label: 'Note', kind: 'textarea', required: true },
            { name: 't:dueAt', label: 'Follow-up time (follow-ups only)', kind: 'datetime-local' },
          ]} />
        </Card>
      )}
    </>
  );
}

async function History({ c }: { c: CandidateView }) {
  const rows = await load<StageHistoryView[]>(`/candidates/${c.id}/history`);
  if (rows === null) return <Empty>You do not have access.</Empty>;
  return <Card wide><Table rows={rows} cols={[{ h: 'When', c: (h) => fmtDateTime(h.changedAt) }, { h: 'From', c: (h) => (h.fromStage ? humanize(h.fromStage) : '—') }, { h: 'To', c: (h) => humanize(h.toStage) }, { h: 'Reason', c: (h) => h.reason ?? '' }]} empty="No changes yet." /></Card>;
}
