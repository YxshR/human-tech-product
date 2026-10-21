import type { LineView, RunItemView } from '@humantech/contracts';
import { loadOr404, type PageProps } from '@/lib/data';
import { Card, Empty, Page, Table, humanize, inr } from '@/components/ui';

export const metadata = { title: 'Pay calculation' };

export default async function ItemPage({ params, searchParams }: PageProps & { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params; const sp = await searchParams;
  const { item, lines } = await loadOr404<{ item: RunItemView; lines: LineView[] }>(`/payroll/runs/${id}/items/${itemId}`);
  return (
    <Page title={item ? `${item.employeeName} · pay calculation` : 'Pay calculation'} sub={item ? `${item.paidDays} paid days of ${item.workingDays}, ${item.unpaidDays} unpaid` : undefined} sp={sp} actions={<a className="btn" href={`/payroll/runs/${id}?tab=items`}>← Back to run</a>}>
      {lines.length === 0 ? <Empty>No lines.</Empty> : (
        <Card wide>
          <Table rows={lines} cols={[
            { h: 'Component', c: (l) => <><strong>{l.label}</strong> <span className="muted">{l.componentCode}</span></> }, { h: 'Type', c: (l) => humanize(l.type) }, { h: 'How', c: (l) => humanize(l.method) },
            { h: 'Based on', right: true, c: (l) => (l.calculationBase ? inr(l.calculationBase) : '—') }, { h: 'Rate', right: true, c: (l) => l.appliedRate ?? '—' }, { h: 'Amount', right: true, c: (l) => inr(l.amount) },
          ]} empty="" />
          {item && <p><strong>Net pay {inr(item.netPay)}</strong> (gross {inr(item.grossEarnings)} − deductions {inr(item.employeeDeductions)})</p>}
        </Card>
      )}
    </Page>
  );
}
