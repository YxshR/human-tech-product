
import {
  DOCUMENT_TYPES, GENDERS, IDENTIFIER_PATTERNS, IDENTIFIER_TYPES, MARITAL, EMPLOYMENT_TYPES,
  type BankView, type BranchView, type DocumentView, type EmergencyContactView, type EmployeeView, type ExitView, type IdentifierView, type OrgItemView, type PersonalView, type TaskView,
} from '@humantech/contracts';
import { uploadDocument } from '@/lib/actions';
import { can, load, loadOr404, options, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Avatar, Card, Details, Empty, Fields, KV, Page, Pill, Table, Tabs, dash, fmtDate, fmtDateTime, humanize, type FieldSpec } from '@/components/ui';
import { SalaryTab, LeaveTab } from './more-tabs';
import { CustomTab } from './custom-tab';

export const metadata = { title: 'Employee' };
const TABS: Array<[string, string]> = [['overview', 'Overview'], ['personal', 'Personal'], ['ids', 'IDs & bank'], ['documents', 'Documents'], ['onboarding', 'Onboarding & exit'], ['custom', 'Custom fields'], ['salary', 'Salary'], ['leave', 'Leave']];

export default async function EmployeePage({ params, searchParams }: PageProps<{ id: string }>) {
  const { id } = await params;
  const sp = await searchParams;
  const e = await loadOr404<EmployeeView>(`/employees/${id}`);
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'overview';
  const base = `/employees/${id}`;
  const back = `${base}?tab=${tab}`;
  return (
    <Page title={`${e.firstName} ${e.lastName ?? ''}`.trim()} avatar={<Avatar name={`${e.firstName} ${e.lastName ?? ''}`} size="lg" />} sub={`Employee no. ${e.employeeNumber}${e.joinedAt ? ` · joined ${fmtDate(e.joinedAt)}` : ''}`} sp={sp} actions={<Pill tone={e.employmentStatus === 'active' ? 'ok' : undefined}>{humanize(e.employmentStatus)}</Pill>}>
      <Tabs base={base} current={tab} items={TABS} />
      {tab === 'overview' && <Overview e={e} back={back} />}
      {tab === 'personal' && <Personal id={id} back={back} />}
      {tab === 'ids' && <IdsBank id={id} back={back} />}
      {tab === 'documents' && <Documents id={id} back={back} />}
      {tab === 'onboarding' && <Onboarding id={id} back={back} status={e.employmentStatus} />}
      {tab === 'custom' && <CustomTab kind="employees" id={id} back={back} />}
      {tab === 'salary' && <SalaryTab id={id} back={back} />}
      {tab === 'leave' && <LeaveTab id={id} back={back} />}
    </Page>
  );
}

async function Overview({ e, back }: { e: EmployeeView; back: string }) {
  const edit = await can('employee.update'); const archive = await can('employee.archive'); const manageLogin = await can('user.manage');
  const users = manageLogin ? ((await load<Array<{ userId: string; email: string; status: string; employeeId: string | null }>>('/access/users')) ?? []) : [];
  const linked = users.find((u) => u.employeeId === e.id);
  const branches = (await load<BranchView[]>('/branches')) ?? []; const departments = (await load<OrgItemView[]>('/org/departments')) ?? []; const designations = (await load<OrgItemView[]>('/org/designations')) ?? [];
  const fields: FieldSpec[] = [
    { name: 's:firstName', label: 'First name', value: e.firstName, required: true }, { name: 's:lastName', label: 'Last name', value: e.lastName ?? '' }, { name: 's:workEmail', label: 'Work email', kind: 'email', value: e.workEmail ?? '' },
    { name: 's:branchId', label: 'Branch', kind: 'select', required: true, value: e.branchId, options: options(branches, (b) => b.id, (b) => b.name) },
    { name: 's:departmentId', label: 'Department', kind: 'select', value: e.departmentId, options: options(departments.filter((d) => d.status === 'active'), (d) => d.id, (d) => d.name) },
    { name: 's:designationId', label: 'Designation', kind: 'select', options: options(designations.filter((d) => d.status === 'active'), (d) => d.id, (d) => d.name) },
    { name: 's:employmentType', label: 'Employment type', kind: 'select', required: true, value: e.employmentType, options: EMPLOYMENT_TYPES.map((t) => [t, humanize(t)]) },
    { name: 'd:joinedAt', label: 'Joining date', kind: 'date', value: e.joinedAt },
  ];
  return (
    <>
      <Card title="Details">
        <KV items={[['Status', humanize(e.employmentStatus)], ['Type', humanize(e.employmentType)], ['Branch', branches.find((b) => b.id === e.branchId)?.name ?? '—'], ['Work email', dash(e.workEmail)], ...(e.phone !== undefined ? [['Phone', dash(e.phone)] as [string, string]] : []), ...(e.personalEmail !== undefined ? [['Personal email', dash(e.personalEmail)] as [string, string]] : [])]} />
      </Card>
      {manageLogin && !['archived', 'exited'].includes(e.employmentStatus) && (
        <Card title="Login">
          <p className="muted">A login lets this person see their own profile, leave, attendance and payslips. Invite them first (Users &amp; access), then link their login here.</p>
          {linked ? (
            <>
              <p>Linked to <strong>{linked.email}</strong></p>
              <ActionButton method="PUT" path={`/employees/${e.id}/login`} back={back} ok="Login removed" values={{ 'z:userId': '' }} button="Remove login" tone="danger" confirm="Remove this person's access to their own records?" />
            </>
          ) : (
            <ActionForm method="PUT" path={`/employees/${e.id}/login`} back={back} ok="Login linked" button="Link login" fields={[
              { name: 's:userId', label: 'Person', kind: 'select', required: true, options: users.filter((u) => u.status === 'active' && !u.employeeId).map((u) => [u.userId, u.email]) },
            ]} />
          )}
        </Card>
      )}
      {edit && (
        <Card title="Edit">
          <ActionForm method="PATCH" path={`/employees/${e.id}`} back={back} ok="Employee updated" button="Save changes" values={{ 'n:version': String(e.version) }} fields={fields} />
          <p className="muted">If someone else changed this record meanwhile you will be asked to reload and try again.</p>
        </Card>
      )}
      {archive && e.employmentStatus !== 'archived' && <Card title="Archive"><p className="muted">Archived employees are hidden from lists and cannot be paid. Their history is kept.</p><ActionButton path={`/employees/${e.id}/archive`} back={`/employees/${e.id}`} ok="Employee archived" button="Archive employee" tone="danger" confirm="Archive this employee?" /></Card>}
    </>
  );
}

const addressFields = (prefix: string, label: string, a: Record<string, unknown> | undefined): FieldSpec[] => [
  { name: `s:${prefix}.line1`, label: `${label}: line 1`, value: (a?.line1 as string) ?? '' }, { name: `s:${prefix}.line2`, label: 'Line 2', value: (a?.line2 as string) ?? '' },
  { name: `s:${prefix}.city`, label: 'City', value: (a?.city as string) ?? '' }, { name: `s:${prefix}.state`, label: 'State', value: (a?.state as string) ?? '' }, { name: `s:${prefix}.postalCode`, label: 'PIN code', value: (a?.postalCode as string) ?? '' },
];

async function Personal({ id, back }: { id: string; back: string }) {
  const p = await load<PersonalView>(`/employees/${id}/personal`);
  const contacts = await load<EmergencyContactView[]>(`/employees/${id}/emergency-contacts`);
  const edit = await can('employee.update_sensitive');
  if (p === null) return <Empty>You do not have access to personal details.</Empty>;
  const has = (a: Record<string, unknown>) => Object.keys(a ?? {}).length > 0;
  return (
    <>
      <Card title="Personal details">
        {edit ? (
          <ActionForm method="PUT" path={`/employees/${id}/personal`} back={back} ok="Personal details saved" button="Save" fields={[
            { name: 'z:dateOfBirth', label: 'Date of birth', kind: 'date', value: p.dateOfBirth }, { name: 'z:gender', label: 'Gender', kind: 'select', value: p.gender, options: GENDERS.map((g) => [g, humanize(g)]) },
            { name: 'z:maritalStatus', label: 'Marital status', kind: 'select', value: p.maritalStatus, options: MARITAL.map((g) => [g, humanize(g)]) }, { name: 'z:nationality', label: 'Nationality', value: p.nationality },
            ...addressFields('currentAddress', 'Current address', has(p.currentAddress) ? p.currentAddress : undefined), ...addressFields('permanentAddress', 'Permanent address', has(p.permanentAddress) ? p.permanentAddress : undefined),
          ]} />
        ) : <KV items={[['Date of birth', fmtDate(p.dateOfBirth)], ['Gender', humanize(p.gender)], ['Marital status', humanize(p.maritalStatus)], ['Nationality', dash(p.nationality)]]} />}
      </Card>
      <Card title="Emergency contacts" wide>
        {contacts === null ? <Empty>No access.</Empty> : (
          <Table rows={contacts} cols={[{ h: 'Name', c: (c) => c.name }, { h: 'Relationship', c: (c) => c.relationship }, { h: 'Phone', c: (c) => c.phone }, { h: '', c: (c) => edit && <ActionButton method="DELETE" path={`/employees/${id}/emergency-contacts/${c.id}`} back={back} ok="Contact removed" button="Remove" tone="danger" /> }]} empty="No emergency contacts." />
        )}
        {edit && <Details summary="Add a contact"><ActionForm path={`/employees/${id}/emergency-contacts`} back={back} ok="Contact added" button="Add" fields={[{ name: 's:name', label: 'Name', required: true }, { name: 's:relationship', label: 'Relationship', required: true }, { name: 's:phone', label: 'Phone', kind: 'tel', required: true }]} /></Details>}
      </Card>
    </>
  );
}

async function IdsBank({ id, back }: { id: string; back: string }) {
  const ids = await load<IdentifierView[]>(`/employees/${id}/identifiers`);
  const bank = await load<BankView[]>(`/employees/${id}/bank`);
  const edit = await can('employee.update_sensitive'); const editBank = await can('employee.update_bank'); const verify = await can('employee.verify_bank');
  return (
    <>
      <Card title="Identity numbers" wide>
        {ids === null ? <Empty>You do not have access to identity numbers.</Empty> : (
          <Table rows={IDENTIFIER_TYPES.map((t) => ({ t, v: ids.find((i) => i.type === t) }))} cols={[
            { h: 'Type', c: (r) => r.t.replace('_', ' ').toUpperCase() }, { h: 'On file', c: (r) => r.v?.masked ?? <span className="muted">—</span> },
            { h: 'Verified', c: (r) => (r.v ? (r.v.verifiedAt ? <Pill tone="ok">{fmtDate(r.v.verifiedAt)}</Pill> : <Pill tone="warn">not yet</Pill>) : '') },
            { h: '', c: (r) => (
              <>
                {edit && <Details summary={r.v ? 'Replace' : 'Add'}><ActionForm inline method="PUT" path={`/employees/${id}/identifiers/${r.t}`} back={back} ok="Saved" button="Save" fields={[{ name: 's:value', label: 'Number', required: true, hint: `Format: ${IDENTIFIER_PATTERNS[r.t].hint}` }]} /></Details>}
                {verify && r.v && !r.v.verifiedAt && <ActionButton path={`/employees/${id}/identifiers/${r.t}/verify`} back={back} ok="Marked as verified" button="Mark verified" />}
              </>
            ) },
          ]} />
        )}
        <p className="muted">Full numbers are never shown; only the last characters.</p>
      </Card>
      <Card title="Bank accounts" wide>
        {bank === null ? <Empty>You do not have access to bank details.</Empty> : (
          <Table rows={bank} cols={[
            { h: 'Holder', c: (b) => b.accountHolderName }, { h: 'Account', c: (b) => `${b.accountNumberMasked}${b.bankName ? ` · ${b.bankName}` : ''}` }, { h: 'IFSC', c: (b) => dash(b.ifsc) }, { h: 'From', c: (b) => fmtDate(b.effectiveFrom) },
            { h: 'Status', c: (b) => <Pill tone={b.status === 'verified' ? 'ok' : b.status === 'pending_verification' ? 'warn' : undefined}>{humanize(b.status)}</Pill> },
            { h: '', c: (b) => b.status === 'pending_verification' && (
              <>
                {verify && <><ActionButton path={`/bank-details/${b.id}/verify`} back={back} ok="Bank account verified" button="Verify" /><ActionButton path={`/bank-details/${b.id}/reject`} back={back} ok="Bank account rejected" button="Reject" tone="danger" /></>}
                {editBank && <ActionButton path={`/bank-details/${b.id}/withdraw`} back={back} ok="Withdrawn" button="Withdraw" />}
              </>
            ) },
          ]} empty="No bank account on file." />
        )}
        {editBank && (
          <Details summary="Add a bank account">
            <p className="muted">A second person verifies new accounts before salary can go to them.</p>
            <ActionForm path={`/employees/${id}/bank`} back={back} ok="Bank account submitted for verification" button="Submit" fields={[
              { name: 's:accountHolderName', label: 'Account holder', required: true }, { name: 's:accountNumber', label: 'Account number', required: true, hint: '9 to 18 digits' }, { name: 's:ifsc', label: 'IFSC', required: true, hint: 'e.g. HDFC0001234' },
              { name: 's:bankName', label: 'Bank name' }, { name: 'd:effectiveFrom', label: 'Effective from', kind: 'date', required: true },
            ]} />
          </Details>
        )}
      </Card>
    </>
  );
}

async function Documents({ id, back }: { id: string; back: string }) {
  const docs = await load<DocumentView[]>(`/employees/${id}/documents`);
  const upload = await can('document.upload'); const del = await can('document.delete'); const verify = await can('employee.update');
  if (docs === null) return <Empty>You do not have access to documents.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={docs} cols={[
          { h: 'Document', c: (d) => <><strong>{d.title ?? humanize(d.documentType)}</strong><div className="muted">{d.filename}</div></> }, { h: 'Type', c: (d) => humanize(d.documentType) },
          { h: 'Status', c: (d) => <Pill tone={d.status === 'verified' ? 'ok' : undefined}>{d.status === 'clean' ? 'uploaded' : d.status}</Pill> }, { h: 'Expires', c: (d) => fmtDate(d.expiresOn) }, { h: 'Added', c: (d) => fmtDateTime(d.createdAt) },
          { h: '', c: (d) => (
            <>
              <a className="btn" href={`/dl/doc/${d.id}`}>Download</a>
              {verify && d.status !== 'verified' && <ActionButton path={`/documents/${d.id}/verify`} back={back} ok="Document verified" button="Verify" />}
              {del && <ActionButton method="DELETE" path={`/documents/${d.id}`} back={back} ok="Document deleted" button="Delete" tone="danger" confirm="Delete this document?" />}
            </>
          ) },
        ]} empty="No documents yet." />
      </Card>
      {upload && (
        <Card title="Upload a document">
          <form action={uploadDocument} className="form">
            <input type="hidden" name="employeeId" value={id} /><input type="hidden" name="_back" value={back} />
            <Fields fields={[{ name: 'documentType', label: 'Type', kind: 'select', required: true, options: DOCUMENT_TYPES.map((t) => [t, humanize(t)]) }, { name: 'title', label: 'Title (optional)' }, { name: 'expiresOn', label: 'Expires on (optional)', kind: 'date' }]} />
            <label>File (PDF, JPG or PNG) *<input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required /></label>
            <button className="btn primary">Upload</button>
          </form>
        </Card>
      )}
    </>
  );
}

async function Onboarding({ id, back, status }: { id: string; back: string; status: string }) {
  const tasks = await load<TaskView[]>(`/employees/${id}/onboarding`);
  const exit = await load<ExitView | null>(`/employees/${id}/exit`);
  const manage = await can('onboarding.manage'); const canExit = await can('employee.exit');
  if (tasks === null && exit === null) return <Empty>You do not have access to onboarding.</Empty>;
  const open = (tasks ?? []).filter((t) => t.status === 'pending' || t.status === 'in_progress');
  return (
    <>
      <Card title="Checklist" wide>
        <Table rows={tasks ?? []} cols={[
          { h: 'Task', c: (t) => <>{t.title}{t.required && <> <Pill>required</Pill></>}<div className="muted">{humanize(t.phase)}</div></> }, { h: 'Due', c: (t) => fmtDate(t.dueDate) }, { h: 'Status', c: (t) => <Pill tone={t.status === 'done' ? 'ok' : undefined}>{humanize(t.status)}</Pill> },
          { h: '', c: (t) => manage && (t.status === 'pending' || t.status === 'in_progress') && (
            <>
              <ActionButton method="PATCH" path={`/onboarding/tasks/${t.id}`} back={back} ok="Task done" values={{ 's:status': 'done' }} button="Mark done" />
              {!t.required ? null : <Details summary="Waive"><ActionForm inline method="PATCH" path={`/onboarding/tasks/${t.id}`} back={back} ok="Task waived" values={{ 's:status': 'waived' }} button="Waive" fields={[{ name: 's:waiverReason', label: 'Reason', required: true }]} /></Details>}
            </>
          ) },
        ]} empty="No tasks yet." />
        {manage && (
          <div className="row" style={{ marginTop: 12 }}>
            <ActionButton path={`/employees/${id}/onboarding/instantiate`} back={back} ok="Checklist created from templates" button="Create checklist from templates" />
            {status === 'onboarding' && <ActionForm inline path={`/employees/${id}/onboarding/complete`} back={back} ok="Onboarding complete" button="Complete onboarding" fields={[{ name: 's:employmentStatus', label: 'Becomes', kind: 'select', required: true, options: [['active', 'Active'], ['probation', 'On probation']] }]} />}
          </div>
        )}
        {manage && open.length === 0 && tasks && tasks.length > 0 && status === 'onboarding' && <p className="muted">All tasks are done. You can complete onboarding.</p>}
        {manage && <Details summary="Add a one-off task"><ActionForm path={`/employees/${id}/onboarding/tasks`} back={back} ok="Task added" button="Add task" fields={[{ name: 's:title', label: 'Title', required: true }, { name: 's:phase', label: 'Phase', kind: 'select', required: true, value: 'onboarding', options: [['onboarding', 'Onboarding'], ['offboarding', 'Offboarding']] }, { name: 'd:dueDate', label: 'Due', kind: 'date' }, { name: 'b:required', label: 'Required', kind: 'checkbox' }]} /></Details>}
      </Card>
      <Card title="Exit">
        {exit ? (
          <>
            <KV items={[['Status', humanize(exit.status)], ['Resigned', fmtDate(exit.resignationDate)], ['Last working day', fmtDate(exit.lastWorkingDate)], ['Final settlement', humanize(exit.finalSettlementStatus)], ['Access removed', exit.accessRevokedAt ? fmtDateTime(exit.accessRevokedAt) : 'No']]} />
            {canExit && exit.status !== 'completed' && exit.status !== 'cancelled' && (
              <Details summary="Update exit">
                <ActionForm method="PATCH" path={`/exits/${exit.id}`} back={back} ok="Exit updated" button="Save" fields={[
                  { name: 's:status', label: 'Move to', kind: 'select', options: [['notice_period', 'Notice period'], ['clearance', 'Clearance'], ['settlement_pending', 'Settlement pending'], ['completed', 'Completed (employee leaves)'], ['cancelled', 'Cancelled']] },
                  { name: 'd:lastWorkingDate', label: 'Last working day', kind: 'date', value: exit.lastWorkingDate }, { name: 's:finalSettlementStatus', label: 'Final settlement', kind: 'select', options: [['not_started', 'Not started'], ['in_progress', 'In progress'], ['paid', 'Paid'], ['not_applicable', 'Not applicable']] },
                  { name: 'b:revokeAccess', label: 'Remove system access now', kind: 'checkbox' }, { name: 's:reasonNotes', label: 'Notes', kind: 'textarea' },
                ]} />
              </Details>
            )}
          </>
        ) : canExit && status !== 'archived' ? (
          <ActionForm path={`/employees/${id}/exit`} back={back} ok="Exit started" button="Start exit" fields={[
            { name: 'd:resignationDate', label: 'Resignation date', kind: 'date' }, { name: 'd:lastWorkingDate', label: 'Last working day', kind: 'date', required: true },
            { name: 's:reasonCode', label: 'Reason', hint: 'e.g. resignation, termination, retirement' }, { name: 's:reasonNotes', label: 'Notes', kind: 'textarea' }, { name: 'b:createTasks', label: 'Create the offboarding checklist', kind: 'checkbox', value: true },
          ]} />
        ) : <Empty>No exit in progress.</Empty>}
      </Card>
    </>
  );
}
