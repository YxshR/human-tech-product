import type { PayslipView } from '@humantech/contracts';
import { can, loadOr404, type PageProps } from '@/lib/data';
import { Card, Page, Table, fmtDateTime, inr } from '@/components/ui';

export const metadata = { title: 'Payslip' };
type Line = { code: string; label: string; amount: string };

export default async function PayslipPage({ params, searchParams }: PageProps & { params: Promise<{ id: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const any = await can('payslip.read_any');
  const p = await loadOr404<PayslipView>(any ? `/payroll/payslips/${id}` : `/me/payslips/${id}`);
  const cols = (h: string) => [{ h, c: (l: Line) => l.label }, { h: 'Amount', right: true, c: (l: Line) => inr(l.amount) }];
  return (
    <Page title={`Payslip ${p.periodCode}`} sub={`${p.employeeName}${p.issuedAt ? ` · issued ${fmtDateTime(p.issuedAt)}` : ''}`} sp={sp}
      actions={<><a className="btn" href={any ? '/payroll' : '/payslips'}>← Back</a><a className="btn primary" href={`/dl/${any ? 'payslip-any' : 'payslip'}/${p.id}`}>Download PDF</a></>}>
      <Card title="Days"><p>{p.paidDays} paid of {p.workingDays} working days ({p.unpaidDays} unpaid)</p></Card>
      <Card title="Earnings" wide><Table rows={p.earnings} cols={cols('Earning')} empty="None" /><p><strong>Gross {inr(p.grossEarnings)}</strong></p></Card>
      <Card title="Deductions" wide><Table rows={p.deductions} cols={cols('Deduction')} empty="None" /><p><strong>Total deductions {inr(p.totalDeductions)}</strong></p></Card>
      {p.employerContributions.length > 0 && <Card title="Employer contributions (not deducted from you)" wide><Table rows={p.employerContributions} cols={cols('Contribution')} empty="" /></Card>}
      <Card><h2>Net pay {inr(p.netPay)}</h2></Card>
    </Page>
  );
}
