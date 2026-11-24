
import {
  DOCUMENT_TYPES, GENDERS, IDENTIFIER_PATTERNS, IDENTIFIER_TYPES, MARITAL, EMPLOYMENT_TYPES,
  type BankView, type BranchView, type DocumentView, type EmergencyContactView, type EmployeeView, type ExitView, type IdentifierView, type OrgItemView, type PersonalView, type TaskView,
} from '@humantech/contracts';
import { uploadDocument } from '@/lib/actions';
import { can, load, loadOr404, options, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Avatar, Callout, Card, Details, Empty, Fields, KV, Page, Pill, Table, Tabs, dash, fmtDate, fmtDateTime, humanize, type FieldSpec, NoAccess } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
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
    <Page title={`${e.firstName} ${e.lastName ?? ''}`.trim()} sub={`Employee no. ${e.employeeNumber} · ${humanize(e.employmentType)}${e.joinedAt ? ` · joined ${fmtDate(e.joinedAt)}` : ''}`} sp={sp}
      back={{ href: '/employees', label: 'Employees' }} lead={<Avatar name={`${e.firstName} ${e.lastName ?? ''}`} size="lg" />} actions={<Pill>{e.employmentStatus}</Pill>}>
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
      {e.employmentStatus === 'onboarding' && <Callout title="This person is still onboarding"><p>Finish their checklist on the “Onboarding &amp; exit” tab, then complete onboarding to make them active.</p></Callout>}
      <Card title="At a glance">
        <KV items={[['Status', <Pill key="s">{e.employmentStatus}</Pill>], ['Employment type', humanize(e.employmentType)], ['Branch', branches.find((b) => b.id === e.branchId)?.name ?? '—'], ['Department', departments.find((d) => d.id === e.departmentId)?.name ?? '—'], ['Work email', dash(e.workEmail)], ...(e.phone !== undefined ? [['Phone', dash(e.phone)] as [string, string]] : []), ...(e.personalEmail !== undefined ? [['Personal email', dash(e.personalEmail)] as [string, string]] : [])]} />
      </Card>
      {manageLogin && !['archived', 'exited'].includes(e.employmentStatus) && (
        <Card title="Sign-in" desc="Linking a sign-in lets this person see their own profile, leave, attendance and payslips.">
          {linked ? (
            <>
              <Callout tone="ok"><p>Linked to <strong>{linked.email}</strong>. They can sign in and see their own records.</p></Callout>
              <ActionButton method="PUT" path={`/employees/${e.id}/login`} back={back} ok="Sign-in unlinked" values={{ 'z:userId': '' }} button="Unlink sign-in" tone="danger" confirm={`Unlink ${linked.email}? They will no longer see their own leave, attendance or payslips. Their account is not deleted.`} />
            </>
          ) : users.some((u) => u.status === 'active' && !u.employeeId) ? (
            <ActionForm method="PUT" path={`/employees/${e.id}/login`} back={back} ok="Sign-in linked" button="Link sign-in" fields={[
              { name: 's:userId', label: 'Which user is this person?', kind: 'select', required: true, options: users.filter((u) => u.status === 'active' && !u.employeeId).map((u) => [u.userId, u.email]), hint: 'Only users who are not linked to another employee are listed.' },
            ]} />
          ) : (
            <Callout tone="plain" title="No one to link yet"><p>Invite this person first, and come back once they have accepted.</p><div className="row"><a className="btn sm" href="/access?tab=invitations">Invite someone</a></div></Callout>
          )}
        </Card>
      )}
      {edit && (
        <Card title="Edit job details" desc="If a colleague changes this record while you are editing, you will be asked to reload so nobody's change is lost.">
          <ActionForm method="PATCH" path={`/employees/${e.id}`} back={back} ok="Employee updated" button="Save changes" values={{ 'n:version': String(e.version) }} fields={fields} />
        </Card>
      )}
      {archive && e.employmentStatus !== 'archived' && <Card title="Archive this employee" desc="Archived employees are hidden from lists and cannot be paid. Their history is kept." tone="danger"><ActionButton path={`/employees/${e.id}/archive`} back={`/employees/${e.id}`} ok="Employee archived" button="Archive employee" tone="danger" confirm={`Archive ${e.firstName}? They disappear from lists and can no longer be paid. Their history is kept.`} /></Card>}
    </>
  );
}

const addressFields = (prefix: string, label: string, a: Record<string, unknown> | undefined): FieldSpec[] => [
  { name: `s:${prefix}.line1`, label: `${label}: house, street`, value: (a?.line1 as string) ?? '' }, { name: `s:${prefix}.line2`, label: `${label}: area, landmark`, value: (a?.line2 as string) ?? '' },
  { name: `s:${prefix}.city`, label: 'City', value: (a?.city as string) ?? '' }, { name: `s:${prefix}.state`, label: 'State', value: (a?.state as string) ?? '' }, { name: `s:${prefix}.postalCode`, label: 'PIN code', value: (a?.postalCode as string) ?? '' },
];

async function Personal({ id, back }: { id: string; back: string }) {
  const p = await load<PersonalView>(`/employees/${id}/personal`);
  const contacts = await load<EmergencyContactView[]>(`/employees/${id}/emergency-contacts`);
  const edit = await can('employee.update_sensitive');
  if (p === null) return <NoAccess what="personal details" />;
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
        {contacts === null ? <NoAccess what="this section" /> : (
          <Table rows={contacts} cols={[{ h: 'Name', c: (c) => c.name }, { h: 'Relationship', c: (c) => c.relationship }, { h: 'Phone', c: (c) => c.phone }, { h: '', c: (c) => edit && <ActionButton method="DELETE" path={`/employees/${id}/emergency-contacts/${c.id}`} back={back} ok="Contact removed" button="Remove" tone="danger" confirm={`Remove ${c.name} as an emergency contact?`} /> }]} empty={<Empty icon="users" title="No emergency contacts">Add someone to call if something happens at work.</Empty>} />
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
      <Card title="Identity numbers" desc="For safety, full numbers are never shown again after saving: only the last few characters." wide>
        {ids === null ? <NoAccess what="identity numbers" /> : (
          <Table rows={IDENTIFIER_TYPES.map((t) => ({ t, v: ids.find((i) => i.type === t) }))} cols={[
            { h: 'Document', c: (r) => <strong>{r.t.replace('_', ' ').toUpperCase()}</strong> }, { h: 'On file', c: (r) => r.v?.masked ?? <span className="muted">Not added</span> },
            { h: 'Checked', c: (r) => (r.v ? (r.v.verifiedAt ? <Pill tone="ok">{`Verified ${fmtDate(r.v.verifiedAt)}`}</Pill> : <Pill tone="warn">Not verified yet</Pill>) : '') },
            { h: '', c: (r) => (
              <>
                {edit && <Details summary={r.v ? 'Replace' : 'Add'}><ActionForm inline method="PUT" path={`/employees/${id}/identifiers/${r.t}`} back={back} ok="Saved" button="Save" fields={[{ name: 's:value', label: 'Number', required: true, hint: `Format: ${IDENTIFIER_PATTERNS[r.t].hint}` }]} /></Details>}
                {verify && r.v && !r.v.verifiedAt && <ActionButton path={`/employees/${id}/identifiers/${r.t}/verify`} back={back} ok="Marked as verified" button="Mark verified" />}
              </>
            ) },
          ]} />
        )}
      </Card>
      <Card title="Bank accounts" desc="Salary is paid only to a verified account. The person who adds an account cannot be the one who verifies it." wide>
        {bank === null ? <NoAccess what="bank details" /> : (
          <Table rows={bank} cols={[
            { h: 'Holder', c: (b) => b.accountHolderName }, { h: 'Account', c: (b) => `${b.accountNumberMasked}${b.bankName ? ` · ${b.bankName}` : ''}` }, { h: 'IFSC', c: (b) => dash(b.ifsc) }, { h: 'From', c: (b) => fmtDate(b.effectiveFrom) },
            { h: 'Status', c: (b) => <Pill>{b.status === 'pending_verification' ? 'Waiting for verification' : b.status}</Pill> },
            { h: '', c: (b) => b.status === 'pending_verification' && (
              <>
                {verify && <><ActionButton path={`/bank-details/${b.id}/verify`} back={back} ok="Bank account verified" button="Verify" tone="primary" confirm="Confirm you have checked this account against a cancelled cheque or bank statement?" /><ActionButton path={`/bank-details/${b.id}/reject`} back={back} ok="Bank account rejected" button="Reject" tone="danger" confirm="Reject this bank account?" /></>}
                {editBank && <ActionButton path={`/bank-details/${b.id}/withdraw`} back={back} ok="Withdrawn" button="Withdraw" />}
              </>
            ) },
          ]} empty={<Empty icon="card" title="No bank account on file">Salary cannot be paid until an account is added and verified.</Empty>} />
        )}
        {editBank && (
          <Details summary="Add a bank account">
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
  if (docs === null) return <NoAccess what="documents" />;
  return (
    <>
      <Card wide>
        <Table rows={docs} cols={[
          { h: 'Document', c: (d) => <><strong>{d.title ?? humanize(d.documentType)}</strong><div className="muted">{d.filename}</div></> }, { h: 'Type', c: (d) => humanize(d.documentType) },
          { h: 'Status', c: (d) => <Pill>{d.status === 'clean' ? 'uploaded' : d.status}</Pill> }, { h: 'Expires', c: (d) => fmtDate(d.expiresOn) }, { h: 'Added', c: (d) => fmtDateTime(d.createdAt) },
          { h: '', c: (d) => (
            <>
              <a className="btn" href={`/dl/doc/${d.id}`}>Download</a>
              {verify && d.status !== 'verified' && <ActionButton path={`/documents/${d.id}/verify`} back={back} ok="Document verified" button="Verify" />}
              {del && <ActionButton method="DELETE" path={`/documents/${d.id}`} back={back} ok="Document deleted" button="Delete" tone="danger" confirm={`Delete “${d.title ?? d.filename}”? This cannot be undone.`} />}
            </>
          ) },
        ]} empty={<Empty icon="upload" title="No documents yet">{upload ? 'Upload offer letters, ID proofs and certificates below.' : 'Documents added for this person appear here.'}</Empty>} />
      </Card>
      {upload && (
        <Card title="Upload a document" desc="PDF, JPG or PNG. Only people whose role allows it can see or download documents.">
          <form action={uploadDocument} className="form">
            <input type="hidden" name="employeeId" value={id} /><input type="hidden" name="_back" value={back} />
            <Fields fields={[{ name: 'documentType', label: 'Type', kind: 'select', required: true, options: DOCUMENT_TYPES.map((t) => [t, humanize(t)]) }, { name: 'title', label: 'Title', placeholder: 'Optional, e.g. Offer letter 2026' }, { name: 'expiresOn', label: 'Expires on', kind: 'date', hint: 'Optional. For documents such as a passport or visa.' }]} />
            <label><span>File<span className="req" aria-hidden="true">*</span></span><input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required /></label>
            <SubmitButton tone="primary">Upload document</SubmitButton>
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
  if (tasks === null && exit === null) return <NoAccess what="onboarding" />;
  const open = (tasks ?? []).filter((t) => t.status === 'pending' || t.status === 'in_progress');
  return (
    <>
      <Card title="Checklist" desc="The tasks to complete for this person. Required tasks must be done (or waived with a reason) before onboarding can be completed." wide>
        <Table rows={tasks ?? []} cols={[
          { h: 'Task', c: (t) => <><strong>{t.title}</strong>{t.required && <> <Pill tag>Required</Pill></>}<div className="muted">{humanize(t.phase)}</div></> }, { h: 'Due', c: (t) => fmtDate(t.dueDate) }, { h: 'Status', c: (t) => <Pill>{t.status === 'pending' ? 'To do' : t.status}</Pill> },
          { h: '', c: (t) => manage && (t.status === 'pending' || t.status === 'in_progress') && (
            <>
              <ActionButton method="PATCH" path={`/onboarding/tasks/${t.id}`} back={back} ok="Task marked as done" values={{ 's:status': 'done' }} button="Mark as done" tone="primary" />
              {!t.required ? null :  <Details summary="Skip"><ActionForm method="PATCH" path={`/onboarding/tasks/${t.id}`} back={back} ok="Task waived" values={{ 's:status': 'waived' }} button="Skip this task" fields={[{ name: 's:waiverReason', label: 'Why is it not needed?', required: true }]} /></Details>}
            </>
          ) },
        ]} empty={<Empty icon="clipboard" title="No checklist yet">{manage ? 'Press “Create checklist from templates” to add your company’s standard tasks, or add a one-off task.' : 'Tasks for this person will appear here.'}</Empty>} />
        {manage && (
          <div className="row" style={{ marginTop: 14 }}>
            <ActionButton path={`/employees/${id}/onboarding/instantiate`} back={back} ok="Checklist created from templates" button="Create checklist from templates" />
            {status === 'onboarding' && <ActionForm inline path={`/employees/${id}/onboarding/complete`} back={back} ok="Onboarding complete" button="Complete onboarding" tone="primary" fields={[{ name: 's:employmentStatus', label: 'After onboarding they become', kind: 'select', required: true, options: [['active', 'Active'], ['probation', 'On probation']] }]} />}
          </div>
        )}
        {manage && open.length === 0 && tasks && tasks.length > 0 && status === 'onboarding' && <div style={{ marginTop: 14 }}><Callout tone="ok" title="All tasks are done"><p>Choose what they become and press “Complete onboarding”.</p></Callout></div>}
        {manage && <Details summary="Add a one-off task"><ActionForm path={`/employees/${id}/onboarding/tasks`} back={back} ok="Task added" button="Add task" fields={[{ name: 's:title', label: 'Title', required: true }, { name: 's:phase', label: 'Phase', kind: 'select', required: true, value: 'onboarding', options: [['onboarding', 'Onboarding'], ['offboarding', 'Offboarding']] }, { name: 'd:dueDate', label: 'Due', kind: 'date' }, { name: 'b:required', label: 'Must be done before onboarding can be completed', kind: 'checkbox' }]} /></Details>}
      </Card>
      <Card title="Leaving the company" desc="Start an exit when this person resigns or is let go. It tracks their notice period, clearance and final settlement.">
        {exit ? (
          <>
            <KV items={[['Status', humanize(exit.status)], ['Resigned', fmtDate(exit.resignationDate)], ['Last working day', fmtDate(exit.lastWorkingDate)], ['Final settlement', humanize(exit.finalSettlementStatus)], ['Access removed', exit.accessRevokedAt ? fmtDateTime(exit.accessRevokedAt) : 'No']]} />
            {canExit && exit.status !== 'completed' && exit.status !== 'cancelled' && (
              <Details summary="Update exit">
                <ActionForm method="PATCH" path={`/exits/${exit.id}`} back={back} ok="Exit updated" button="Save" fields={[
                  { name: 's:status', label: 'Move to', kind: 'select', options: [['notice_period', 'Notice period'], ['clearance', 'Clearance'], ['settlement_pending', 'Settlement pending'], ['completed', 'Completed (employee leaves)'], ['cancelled', 'Cancelled']] },
                  { name: 'd:lastWorkingDate', label: 'Last working day', kind: 'date', value: exit.lastWorkingDate }, { name: 's:finalSettlementStatus', label: 'Final settlement', kind: 'select', options: [['not_started', 'Not started'], ['in_progress', 'In progress'], ['paid', 'Paid'], ['not_applicable', 'Not applicable']] },
                  { name: 'b:revokeAccess', label: 'Remove their sign-in access now', kind: 'checkbox', hint: 'They are signed out immediately and cannot sign back in.' }, { name: 's:reasonNotes', label: 'Notes', kind: 'textarea' },
                ]} />
              </Details>
            )}
          </>
        ) : canExit && status !== 'archived' ? (
          <ActionForm path={`/employees/${id}/exit`} back={back} ok="Exit started" button="Start exit" tone="danger" confirm="Start the exit process for this person?" fields={[
            { name: 'd:resignationDate', label: 'Resignation date', kind: 'date' }, { name: 'd:lastWorkingDate', label: 'Last working day', kind: 'date', required: true },
            { name: 's:reasonCode', label: 'Reason', hint: 'e.g. resignation, termination, retirement' }, { name: 's:reasonNotes', label: 'Notes', kind: 'textarea' }, { name: 'b:createTasks', label: 'Create the leaving checklist from templates', kind: 'checkbox', value: true },
          ]} />
        ) : <Empty icon="logout" title="No exit in progress">This person is not leaving.</Empty>}
      </Card>
    </>
  );
}
