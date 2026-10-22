import type { AttendancePolicyView, ShiftView } from '@humantech/contracts';
import { employeeOptions, load, today, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, Page, Pill, Table, Tabs, fmtDate, humanize } from '@/components/ui';

export const metadata = { title: 'Attendance policy' };
const TABS: Array<[string, string]> = [['shifts', 'Shifts'], ['policies', 'Policies'], ['assign', 'Assign shifts']];
const DAYS: Array<[string, string]> = [['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday']];

export default async function AttendanceAdmin({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'shifts';
  const back = `/attendance/admin?tab=${tab}`;
  const shifts = await load<ShiftView[]>('/attendance/shifts', { includeInactive: 'true' });
  return (
    <Page title="Attendance policy" sub="Shifts, rules for lateness and missing punches, and who works which shift" sp={sp}>
      <Tabs base="/attendance/admin" current={tab} items={TABS} />
      {shifts === null ? <Empty>You do not have access to attendance policy.</Empty> : tab === 'shifts' ? <Shifts shifts={shifts} back={back} /> : tab === 'policies' ? <Policies back={back} /> : <Assign shifts={shifts} back={back} />}
    </Page>
  );
}

function Shifts({ shifts, back }: { shifts: ShiftView[]; back: string }) {
  return (
    <>
      <Card wide>
        <Table rows={shifts} cols={[
          { h: 'Code', c: (s) => s.code }, { h: 'Name', c: (s) => s.name }, { h: 'Hours', c: (s) => `${s.startTime}–${s.endTime}${s.crossesMidnight ? ' (overnight)' : ''}` }, { h: 'Grace', right: true, c: (s) => `${s.graceMinutes} min` },
          { h: 'Half / full day', right: true, c: (s) => `${s.halfDayMinutes} / ${s.fullDayMinutes} min` }, { h: 'Weekly off', c: (s) => s.weeklyOffDays.map((d) => DAYS[d]![1]!.slice(0, 3)).join(', ') || 'None' },
          { h: 'Status', c: (s) => <Pill tone={s.status === 'active' ? 'ok' : undefined}>{s.status}</Pill> },
          { h: '', c: (s) => <ActionButton method="PATCH" path={`/attendance/shifts/${s.id}`} back={back} ok="Shift updated" values={{ 's:status': s.status === 'active' ? 'inactive' : 'active' }} button={s.status === 'active' ? 'Switch off' : 'Switch on'} /> },
        ]} empty="No shifts yet." />
      </Card>
      <Card title="Add a shift">
        <ActionForm path="/attendance/shifts" back={back} ok="Shift added" button="Add shift" fields={[
          { name: 's:code', label: 'Code', required: true }, { name: 's:name', label: 'Name', required: true }, { name: 's:startTime', label: 'Starts (24h)', kind: 'time', required: true, value: '09:30' }, { name: 's:endTime', label: 'Ends (24h)', kind: 'time', required: true, value: '18:30' },
          { name: 'n:graceMinutes', label: 'Grace minutes', kind: 'number', value: 10, min: 0, max: 240 }, { name: 'n:halfDayMinutes', label: 'Minutes for a half day', kind: 'number', value: 240, min: 1 }, { name: 'n:fullDayMinutes', label: 'Minutes for a full day', kind: 'number', value: 480, min: 1 },
          { name: 'i:weeklyOffDays', label: 'Weekly off (hold Ctrl/Cmd for several)', kind: 'multiselect', options: DAYS, value: ['0'] },
        ]} />
      </Card>
    </>
  );
}

async function Policies({ back }: { back: string }) {
  const policies = (await load<AttendancePolicyView[]>('/attendance/policies')) ?? [];
  return (
    <>
      <Card wide>
        <Table rows={policies} cols={[
          { h: 'Name', c: (p) => p.name }, { h: 'Version', right: true, c: (p) => p.version }, { h: 'From', c: (p) => fmtDate(p.effectiveFrom) }, { h: 'Missing punch', c: (p) => humanize(p.missingPunchPolicy) },
          { h: 'Self check-in', c: (p) => (p.allowEmployeeCheckin ? 'Allowed' : 'Off') }, { h: 'Correction window', right: true, c: (p) => `${p.correctionWindowDays} days` }, { h: 'Status', c: (p) => <Pill tone={p.status === 'active' ? 'ok' : p.status === 'draft' ? 'warn' : undefined}>{p.status}</Pill> },
          { h: '', c: (p) => (p.status === 'draft' ? <ActionButton path={`/attendance/policies/${p.id}/activate`} back={back} ok="Policy active" button="Activate" /> : p.status === 'active' ? <ActionButton path={`/attendance/policies/${p.id}/retire`} back={back} ok="Policy retired" button="Retire" tone="danger" confirm="Retire this policy?" /> : null) },
        ]} empty="No policies yet." />
      </Card>
      <Card title="Add a policy">
        <p className="muted">New policies start as drafts. Activate one to put it into effect.</p>
        <ActionForm path="/attendance/policies" back={back} ok="Policy added as a draft" button="Add policy" fields={[
          { name: 's:name', label: 'Name', required: true }, { name: 'd:effectiveFrom', label: 'Effective from', kind: 'date', required: true, value: today() }, { name: 'd:effectiveTo', label: 'Effective to', kind: 'date' },
          { name: 's:missingPunchPolicy', label: 'When a punch is missing', kind: 'select', required: true, value: 'flag', options: [['flag', 'Flag for HR'], ['half_day', 'Count as half day'], ['absent', 'Count as absent']] },
          { name: 'b:allowEmployeeCheckin', label: 'Employees can check in and out themselves', kind: 'checkbox' }, { name: 'b:lateAfterGraceCountsAsLate', label: 'Count arrivals after the grace time as late', kind: 'checkbox', value: true },
          { name: 'n:lateMarksPerHalfDay', label: 'Late marks that cost a half day (optional)', kind: 'number', min: 1, max: 31 }, { name: 'n:correctionWindowDays', label: 'Days allowed to ask for a correction', kind: 'number', value: 7, min: 0, max: 90 }, { name: 'b:overtimeEnabled', label: 'Track overtime', kind: 'checkbox' },
        ]} />
      </Card>
    </>
  );
}

async function Assign({ shifts, back }: { shifts: ShiftView[]; back: string }) {
  const people = await employeeOptions();
  return (
    <Card title="Assign a shift">
      <p className="muted">A new assignment replaces the person&apos;s earlier one from its start date.</p>
      <ActionForm path="/attendance/shift-assignments" back={back} ok="Shift assigned" button="Assign" fields={[
        { name: 's:employeeId', label: 'Employee', kind: 'select', required: true, options: people }, { name: 's:shiftId', label: 'Shift', kind: 'select', required: true, options: shifts.filter((s) => s.status === 'active').map((s) => [s.id, `${s.name} (${s.startTime}–${s.endTime})`]) },
        { name: 'd:effectiveFrom', label: 'From', kind: 'date', required: true, value: today() }, { name: 'd:effectiveTo', label: 'To (optional)', kind: 'date' },
      ]} />
    </Card>
  );
}
