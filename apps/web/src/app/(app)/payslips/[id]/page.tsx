import type { PayslipView } from '@humantech/contracts';
import { can, loadOr404, type PageProps } from '@/lib/data';
import { Card, Page, Tiles, fmtDate, inr } from '@/components/ui';
import { Icon } from '@/components/icons';

export const metadata = { title: 'Payslip' };
type Line = { code: string; label: string; amount: string };

const Lines = ({ rows, total, totalLabel }: { rows: Line[]; total?: string; totalLabel?: string }) => (
  <div>
    {rows.length === 0 && <p className="muted">None this month.</p>}
    {rows.map((l) => <div key={l.code} className="amount-row"><span>{l.label}</span><span>{inr(l.amount)}</span></div>)}
    {total !== undefined && <div className="amount-row total"><span>{totalLabel}</span><span>{inr(total)}</span></div>}
  </div>
);

export default async function PayslipPage({ params, searchParams }: PageProps & { params: Promise<{ id: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const any = await can('payslip.read_any');
  const p = await loadOr404<PayslipView>(any ? `/payroll/payslips/${id}` : `/me/payslips/${id}`);
  return (
    <Page title={`Payslip for ${p.periodCode}`} sub={`${p.employeeName}${p.issuedAt ? ` · issued on ${fmtDate(p.issuedAt)}` : ''}${p.revision > 1 ? ` · revision ${p.revision}` : ''}`} sp={sp}
      back={any ? { href: '/payroll', label: 'Payroll' } : { href: '/payslips', label: 'My payslips' }}
      actions={<a className="btn primary" href={`/dl/${any ? 'payslip-any' : 'payslip'}/${p.id}`}><Icon name="download" size={16} />Download PDF</a>}>
      <div className="netpay" style={{ maxWidth: 760 }}>
        <span>Take-home pay<small>Earnings minus deductions</small></span>
        <b>{inr(p.netPay)}</b>
      </div>
      <Card title="Days paid" desc="Your pay is based on the days you were paid for in this period.">
        <Tiles items={[{ label: 'Working days', value: p.workingDays }, { label: 'Paid days', value: p.paidDays, tone: 'ok' }, { label: 'Unpaid days', value: p.unpaidDays, tone: Number(p.unpaidDays) > 0 ? 'warn' : undefined }]} />
      </Card>
      <div className="grid2" style={{ maxWidth: 760 }}>
        <Card title="Earnings" wide><Lines rows={p.earnings} total={p.grossEarnings} totalLabel="Gross pay" /></Card>
        <Card title="Deductions" wide><Lines rows={p.deductions} total={p.totalDeductions} totalLabel="Total deductions" /></Card>
      </div>
      {p.employerContributions.length > 0 && (
        <Card title="Paid by your employer" desc="These are paid on top of your salary. They are not taken out of your pay."><Lines rows={p.employerContributions} /></Card>
      )}
    </Page>
  );
}
