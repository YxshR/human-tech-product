import type { AttendanceDayView, AttendanceSummaryView, CorrectionView, PayrollPeriodLite } from './types';
import { MARKABLE_STATUSES } from '@humantech/contracts';
import { can, employeeOptions, isMonth, load, loadPaged, monthRange, myself, thisMonth, today, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Callout, Card, Details, Empty, Page, Pager, Pill, Table, Tabs, Tiles, fmtDate, fmtDateTime, fmtMonth, humanize, NoAccess } from '@/components/ui';

export const metadata = { title: 'Attendance' };

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
    <Page title="Attendance" sub={tab === 'me' ? 'Check in and out each working day, and see your month so far.' : tab === 'team' ? 'Everyone\u2019s attendance. Fix a day, close a day, or lock a period so payroll can start.' : 'Requests to fix a day that was recorded wrongly.'} sp={sp}>
      {tabs.length > 1 && <Tabs base={`/attendance?month=${month}`} current={tab} items={tabs} />}
      {tab === 'me' && <Me back={back} month={month} />}
      {tab === 'team' && <Team back={back} month={month} sp={sp} />}
      {tab === 'corrections' && <Corrections back={back} />}
    </Page>
  );
}

function MonthPicker({ tab, month }: { tab: string; month: string }) {
  return <form className="row" style={{ marginBottom: 16 }}><input type="hidden" name="tab" value={tab} /><label>Month<input type="month" name="month" defaultValue={month} /></label><button className="btn">Show month</button></form>;
}

async function Me({ back, month }: { back: string; month: string }) {
  const { from, to } = monthRange(month);
  const t = today();
  const todayRow = (await load<AttendanceDayView[]>('/attendance/days', { from: t, to: t }))?.[0];
  const days = await load<AttendanceDayView[]>('/attendance/days', { from, to, limit: '62' });
  const summary = await load<AttendanceSummaryView>('/attendance/summary', { month });
  const punch = (await can('attendance.checkin_own')) && !!(await myself()).employeeId; const correct = await can('attendance.request_correction_own');
  return (
    <>
      {punch && (
        <Card title={`Today · ${fmtDate(t)}`}
          action={!todayRow?.checkInAt ? <ActionButton path="/attendance/check-in" back={back} ok="Checked in. Have a good day!" button="Check in now" tone="primary" />
            : !todayRow.checkOutAt ? <ActionButton path="/attendance/check-out" back={back} ok="Checked out. See you tomorrow!" button="Check out" tone="primary" /> : <Pill tone="ok">Day complete</Pill>}>
          <Tiles items={[{ label: 'Checked in', value: hm(todayRow?.checkInAt ?? null), tone: todayRow?.checkInAt ? 'ok' : undefined }, { label: 'Checked out', value: hm(todayRow?.checkOutAt ?? null), tone: todayRow?.checkOutAt ? 'ok' : undefined }]} />
          {!todayRow?.checkInAt && <p className="muted" style={{ marginTop: 12 }}>You have not checked in yet. Press “Check in now” when you start work.</p>}
          {todayRow?.checkInAt && !todayRow.checkOutAt && <p className="muted" style={{ marginTop: 12 }}>Remember to check out when you finish for the day.</p>}
        </Card>
      )}
      <MonthPicker tab="me" month={month} />
      {summary && (
        <Card title={`${fmtMonth(month)} so far`} desc="Paid days are what payroll uses for this month." wide>
          <Tiles items={[{ label: 'Present', value: summary.presentDays, tone: 'ok' }, { label: 'Work from home', value: summary.workFromHomeDays }, { label: 'Half days', value: summary.halfDays }, { label: 'On leave', value: summary.leaveDays }, { label: 'Absent', value: summary.absentDays, tone: Number(summary.absentDays) > 0 ? 'bad' : undefined }, { label: 'Late arrivals', value: summary.lateDays, tone: Number(summary.lateDays) > 0 ? 'warn' : undefined }, { label: 'Paid days', value: summary.paidDays, tone: 'strong' }, { label: 'Unpaid days', value: summary.unpaidDays, tone: Number(summary.unpaidDays) > 0 ? 'warn' : undefined }]} />
        </Card>
      )}
      <Card title="Day by day" desc={correct ? 'Something recorded wrongly? Use “Ask for a correction” on that day and your approver will review it.' : undefined} wide>
        {days === null ? <Empty icon="clock" title="No attendance for this sign-in">Attendance belongs to employee records, and this sign-in is not linked to one. Ask HR to link it if you should be checking in.</Empty> : (
          <Table rows={days} cols={[
            { h: 'Date', c: (d) => fmtDate(d.workDate) }, { h: 'Status', c: (d) => <Pill>{d.status}</Pill> }, { h: 'In', c: (d) => hm(d.checkInAt) }, { h: 'Out', c: (d) => hm(d.checkOutAt) },
            { h: 'Late by (min)', right: true, c: (d) => (d.lateMinutes ? d.lateMinutes : '—') }, { h: 'Recorded by', c: (d) => humanize(d.source) },
            { h: '', c: (d) => correct && d.workDate < t && (
              <Details summary="Ask for a correction">
                <ActionForm path="/attendance/corrections" back={back} ok="Correction requested" button="Send for review" values={{ 'd:workDate': d.workDate }} fields={[
                  { name: 's:requested.status', label: 'What it should say', kind: 'select', required: true, options: MARKABLE_STATUSES.filter((s) => s !== 'not_marked').map((s) => [s, humanize(s)]) }, { name: 's:reason', label: 'What happened', required: true, placeholder: 'e.g. Forgot to check in' },
                ]} />
              </Details>
            ) },
          ]} empty={<Empty icon="clock" title={`Nothing recorded in ${fmtMonth(month)}`}>Days appear here once you check in.</Empty>} />
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
  if (days === null) return <NoAccess what={"the team's attendance"} />;
  return (
    <>
      <form className="row card" style={{ marginBottom: 16 }}>
        <input type="hidden" name="tab" value="team" /><input type="hidden" name="month" value={month} />
        <label>From<input type="date" name="from" defaultValue={from} /></label><label>To<input type="date" name="to" defaultValue={to} /></label>
        <label>Status<select name="status" defaultValue={sp.status ?? ''}><option value="">Any status</option>{['present', 'absent', 'half_day', 'leave', 'holiday', 'weekly_off', 'work_from_home', 'not_marked'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select></label>
        <button className="btn">Show</button>
      </form>
      <Card wide>
        <Table caption="Team attendance" rows={days.rows} cols={[
          { h: 'Employee', c: (d) => <><strong>{d.employeeName}</strong><div className="muted">{d.employeeNumber}</div></> }, { h: 'Date', c: (d) => fmtDate(d.workDate) }, { h: 'Status', c: (d) => <Pill>{d.status}</Pill> },
          { h: 'In', c: (d) => hm(d.checkInAt) }, { h: 'Out', c: (d) => hm(d.checkOutAt) }, { h: 'Late by (min)', right: true, c: (d) => (d.lateMinutes ? d.lateMinutes : '—') }, { h: 'Paid day', right: true, c: (d) => (Number(d.paidDayFraction) === 1 ? 'Full' : Number(d.paidDayFraction) === 0.5 ? 'Half' : Number(d.paidDayFraction) === 0 ? 'None' : d.paidDayFraction) },
        ]} empty={<Empty icon="clock" title="No attendance for these dates">Change the dates or status above, or mark a day below.</Empty>} />
        <Pager base="/attendance" query={{ tab: 'team', month, from: sp.from, to: sp.to, status: sp.status }} nextCursor={days.next} started={!!sp.cursor} />
      </Card>
      <div className="grid2">
        {mark && (
          <Card title="Mark a day for someone" desc="Sets or corrects one person's status for one day. The reason is kept in the audit log." wide>
            <ActionForm cols={false} path="/attendance/days/mark" back={back} ok="Attendance saved" button="Save attendance" fields={[
              { name: 's:employeeId', label: 'Employee', kind: 'select', required: true, options: people }, { name: 'd:workDate', label: 'Date', kind: 'date', required: true, max: today() },
              { name: 's:status', label: 'Status', kind: 'select', options: MARKABLE_STATUSES.map((s) => [s, humanize(s)]) }, { name: 's:reason', label: 'Reason', required: true },
            ]} />
          </Card>
        )}
        {mark && (
 <Card title="Close a day" desc="Applies your company's rule (flag, half day or absent) to anyone who did not check in or out that day. This normally happens by itself overnight; use it only to do it sooner." wide>
            <ActionForm path="/attendance/finalize" back={back} ok="Day closed" button="Close this day" confirm="Close this day now? People with missing check-ins will be marked using your company's rule." fields={[{ name: 'd:date', label: 'Date', kind: 'date', required: true, value: today() }]} />
          </Card>
        )}
        {lock && (
          <Card title="Lock attendance for payroll" desc="Do this when the month's attendance is final. After locking, nobody can change it and the pay run for that period can start." wide>
            {periods.length === 0 ? <Callout tone="plain"><p>There is no open payroll period to lock. Periods are created in Payroll → Setup.</p></Callout> : <ActionForm path="/attendance/lock" back={back} ok="Attendance locked. Payroll can now start for this period." button="Lock attendance" tone="danger" confirm="Lock attendance for this period? Nobody will be able to change it afterwards. This cannot be undone." fields={[{ name: 's:periodId', label: 'Payroll period', kind: 'select', required: true, options: periods.map((p) => [p.id, p.periodCode]) }]} />}
          </Card>
        )}
      </div>
    </>
  );
}

async function Corrections({ back }: { back: string }) {
  const rows = await load<CorrectionView[]>('/attendance/corrections');
  const review = await can('attendance.approve_correction');
  if (rows === null) return <NoAccess what="corrections" />;
  return (
    <Card wide>
      <Table rows={rows} cols={[
        { h: 'Employee', c: (c) => <strong>{c.employeeName}</strong> }, { h: 'Day', c: (c) => fmtDate(c.workDate) }, { h: 'Should say', c: (c) => Object.entries(c.requested).filter(([, v]) => v).map(([k, v]) => `${humanize(k)}: ${k.endsWith('At') ? fmtDateTime(String(v)) : humanize(String(v))}`).join(', ') },
        { h: 'Reason', c: (c) => c.reason }, { h: 'Status', c: (c) => <Pill>{c.status === 'pending' ? 'Waiting' : c.status}</Pill> },
        { h: '', c: (c) => c.status === 'pending' && (
          <>
            {review && <><ActionButton path={`/attendance/corrections/${c.id}/approve`} back={back} ok="Correction approved and applied" button="Approve" tone="primary" /><ActionButton path={`/attendance/corrections/${c.id}/reject`} back={back} ok="Correction rejected" button="Reject" tone="danger" /></>}
            <ActionButton path={`/attendance/corrections/${c.id}/cancel`} back={back} ok="Request cancelled" button="Withdraw" confirm="Withdraw this correction request?" />
          </>
        ) },
      ]} empty={<Empty icon="clock" title="No correction requests">When someone asks to fix a day, it appears here.</Empty>} />
    </Card>
  );
}
