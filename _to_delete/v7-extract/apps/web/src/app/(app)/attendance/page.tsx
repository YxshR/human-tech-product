import type { AttendanceDayView, AttendanceSummaryView, CorrectionView, PayrollPeriodLite } from './types';
import { MARKABLE_STATUSES } from '@humantech/contracts';
import { can, employeeOptions, isMonth, load, loadPaged, monthRange, thisMonth, today, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Details, Empty, KV, Page, Pager, Pill, Table, Tabs, fmtDate, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'Attendance' };

const dayTone = (s: string) => (s === 'present' || s === 'work_from_home' ? 'ok' : s === 'absent' ? 'bad' : s === 'half_day' || s === 'not_marked' ? 'warn' : undefined);
const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');

export default async function Attendance({ searchParams }: PageProps) {
  const sp = await searchParams;
  const manager = await can('attendance.read');
  const approver = await can('attendance.approve_correction', 'attendance.correct');
  const tabs: Array<[string, string]> = [['me', 'My attendance']];
  if (manager) tabs.push(['team', 'Team']);
  if (approver || manager) tabs.push(['corrections', 'Corrections']);
  const tab = tabs.some(([k]) => k === sp.tab) ? sp.tab! : 'me';
  const month = isMonth(sp.month) ? sp.month : thisMonth();
  const back = `/attendance?tab=${tab}&month=${month}`;
  return (
    <Page title="Attendance" sp={sp}>
      <Tabs base={`/attendance?month=${month}`} current={tab} items={tabs} />
      {tab === 'me' && <Me back={back} month={month} />}
      {tab === 'team' && <Team back={back} month={month} sp={sp} />}
      {tab === 'corrections' && <Corrections back={back} />}
    </Page>
  );
}

function MonthPicker({ tab, month }: { tab: string; month: string }) {
  return <form className="row" style={{ marginBottom: 12 }}><input type="hidden" name="tab" value={tab} /><label>Month<input type="month" name="month" defaultValue={month} /></label><button className="btn">Show</button></form>;
}

async function Me({ back, month }: { back: string; month: string }) {
  const { from, to } = monthRange(month);
  const t = today();
  const todayRow = (await load<AttendanceDayView[]>('/attendance/days', { from: t, to: t }))?.[0];
  const days = await load<AttendanceDayView[]>('/attendance/days', { from, to, limit: '62' });
  const summary = await load<AttendanceSummaryView>('/attendance/summary', { month });
  const punch = await can('attendance.checkin_own'); const correct = await can('attendance.request_correction_own');
  return (
    <>
      {punch && (
        <Card title="Today">
          <p>{todayRow?.checkInAt ? <>Checked in at <strong>{hm(todayRow.checkInAt)}</strong>{todayRow.checkOutAt ? <> and out at <strong>{hm(todayRow.checkOutAt)}</strong>.</> : '.'}</> : 'You have not checked in yet.'}</p>
          <div className="row">
            {!todayRow?.checkInAt && <ActionButton path="/attendance/check-in" back={back} ok="Checked in" button="Check in" tone="primary" />}
            {todayRow?.checkInAt && !todayRow.checkOutAt && <ActionButton path="/attendance/check-out" back={back} ok="Checked out" button="Check out" tone="primary" />}
          </div>
        </Card>
      )}
      <MonthPicker tab="me" month={month} />
      {summary && (
        <Card title={`Summary for ${month}`} wide>
          <KV items={[['Present', summary.presentDays], ['Half days', summary.halfDays], ['Absent', summary.absentDays], ['On leave', summary.leaveDays], ['Work from home', summary.workFromHomeDays], ['Late', summary.lateDays], ['Paid days', summary.paidDays], ['Unpaid days', summary.unpaidDays]]} />
        </Card>
      )}
      <Card title="Days" wide>
        {days === null ? <Empty>You do not have attendance records.</Empty> : (
          <Table rows={days} cols={[
            { h: 'Date', c: (d) => fmtDate(d.workDate) }, { h: 'Status', c: (d) => <Pill tone={dayTone(d.status)}>{humanize(d.status)}</Pill> }, { h: 'In', c: (d) => hm(d.checkInAt) }, { h: 'Out', c: (d) => hm(d.checkOutAt) },
            { h: 'Late (min)', right: true, c: (d) => d.lateMinutes }, { h: 'Source', c: (d) => d.source },
            { h: '', c: (d) => correct && d.workDate < t && (
              <Details summary="Ask for a correction">
                <ActionForm path="/attendance/corrections" back={back} ok="Correction requested" button="Send" values={{ 'd:workDate': d.workDate }} fields={[
                  { name: 's:requested.status', label: 'Should be', kind: 'select', required: true, options: MARKABLE_STATUSES.filter((s) => s !== 'not_marked').map((s) => [s, humanize(s)]) }, { name: 's:reason', label: 'Why', required: true },
                ]} />
              </Details>
            ) },
          ]} empty="No days recorded this month." />
        )}
      </Card>
    </>
  );
}

async function Team({ back, month, sp }: { back: string; month: string; sp: { from?: string; to?: string; status?: string; employeeId?: string; cursor?: string } }) {
  const range = monthRange(month);
  const from = sp.from ?? range.from; const to = sp.to ?? range.to;
  const days = await loadPaged<AttendanceDayView>('/attendance/days', { from, to, status: sp.status, employeeId: sp.employeeId, cursor: sp.cursor, limit: '50' });
  const mark = await can('attendance.mark'); const lock = await can('attendance.lock');
  const people = mark ? await employeeOptions() : [];
  const periods = lock ? ((await load<PayrollPeriodLite[]>('/payroll/periods')) ?? []).filter((p) => !p.attendanceLockedAt) : [];
  if (days === null) return <Empty>You do not have access to the team&apos;s attendance.</Empty>;
  return (
    <>
      <form className="row card" style={{ marginBottom: 16 }}>
        <input type="hidden" name="tab" value="team" /><input type="hidden" name="month" value={month} />
        <label>From<input type="date" name="from" defaultValue={from} /></label><label>To<input type="date" name="to" defaultValue={to} /></label>
        <label>Status<select name="status" defaultValue={sp.status ?? ''}><option value="">All</option>{['present', 'absent', 'half_day', 'leave', 'holiday', 'weekly_off', 'work_from_home', 'not_marked'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select></label>
        <button className="btn">Filter</button>
      </form>
      <Card wide>
        <Table rows={days.rows} cols={[
          { h: 'Employee', c: (d) => <>{d.employeeName}<div className="muted">{d.employeeNumber}</div></> }, { h: 'Date', c: (d) => fmtDate(d.workDate) }, { h: 'Status', c: (d) => <Pill tone={dayTone(d.status)}>{humanize(d.status)}</Pill> },
          { h: 'In', c: (d) => hm(d.checkInAt) }, { h: 'Out', c: (d) => hm(d.checkOutAt) }, { h: 'Late (min)', right: true, c: (d) => d.lateMinutes }, { h: 'Paid fraction', right: true, c: (d) => d.paidDayFraction },
        ]} empty="No attendance for these filters." />
        <Pager base="/attendance" query={{ tab: 'team', month, from: sp.from, to: sp.to, status: sp.status }} nextCursor={days.next} />
      </Card>
      <div className="grid2">
        {mark && (
          <Card title="Mark attendance" wide>
            <ActionForm path="/attendance/days/mark" back={back} ok="Attendance saved" button="Save" fields={[
              { name: 's:employeeId', label: 'Employee', kind: 'select', required: true, options: people }, { name: 'd:workDate', label: 'Date', kind: 'date', required: true, max: today() },
              { name: 's:status', label: 'Status', kind: 'select', options: MARKABLE_STATUSES.map((s) => [s, humanize(s)]) }, { name: 's:reason', label: 'Reason', required: true },
            ]} />
          </Card>
        )}
        {mark && (
          <Card title="Close a day" wide>
            <p className="muted">Turns today&apos;s missing punches into the company&apos;s rule (flag, half day or absent). Normally runs by itself overnight.</p>
            <ActionForm path="/attendance/finalize" back={back} ok="Day closed" button="Close day" fields={[{ name: 'd:date', label: 'Date', kind: 'date', required: true, value: today() }]} />
          </Card>
        )}
        {lock && (
          <Card title="Lock attendance for payroll" wide>
            <p className="muted">Once locked, attendance for the period can no longer change, and payroll can start.</p>
            <ActionForm path="/attendance/lock" back={back} ok="Attendance locked" button="Lock" confirm="Lock attendance for this period? This cannot be undone." fields={[{ name: 's:periodId', label: 'Payroll period', kind: 'select', required: true, options: periods.map((p) => [p.id, p.periodCode]) }]} />
          </Card>
        )}
      </div>
    </>
  );
}

async function Corrections({ back }: { back: string }) {
  const rows = await load<CorrectionView[]>('/attendance/corrections');
  const review = await can('attendance.approve_correction');
  if (rows === null) return <Empty>You do not have access to corrections.</Empty>;
  return (
    <Card wide>
      <Table rows={rows} cols={[
        { h: 'Employee', c: (c) => c.employeeName }, { h: 'Date', c: (c) => fmtDate(c.workDate) }, { h: 'Wants', c: (c) => Object.entries(c.requested).filter(([, v]) => v).map(([k, v]) => `${humanize(k)}: ${k.endsWith('At') ? fmtDateTime(String(v)) : humanize(String(v))}`).join(', ') },
        { h: 'Why', c: (c) => c.reason }, { h: 'Status', c: (c) => <Pill tone={c.status === 'approved' ? 'ok' : c.status === 'pending' ? 'warn' : undefined}>{c.status}</Pill> },
        { h: '', c: (c) => c.status === 'pending' && (
          <>
            {review && <><ActionButton path={`/attendance/corrections/${c.id}/approve`} back={back} ok="Correction approved" button="Approve" /><ActionButton path={`/attendance/corrections/${c.id}/reject`} back={back} ok="Correction rejected" button="Reject" tone="danger" /></>}
            <ActionButton path={`/attendance/corrections/${c.id}/cancel`} back={back} ok="Request cancelled" button="Cancel" />
          </>
        ) },
      ]} empty="No correction requests." />
    </Card>
  );
}
