import { load, type PageProps } from '@/lib/data';
import { Card, Empty, Page, Table, fmtDateTime, inr } from '@/components/ui';

type MyPayslip = { id: string; periodCode: string; revision: number; status: string; netPay: string; issuedAt: string | null };
export const metadata = { title: 'My payslips' };

export default async function Payslips({ searchParams }: PageProps) {
  const sp = await searchParams;
  const rows = await load<MyPayslip[]>('/me/payslips');
  return (
    <Page title="My payslips" sp={sp}>
      {rows === null ? <Empty>Payslips are not available for your account.</Empty> : (
        <Card wide>
          <Table rows={rows} cols={[
            { h: 'Period', c: (p) => <a href={`/payslips/${p.id}`}>{p.periodCode}{p.revision > 1 ? ` (revised)` : ''}</a> }, { h: 'Net pay', right: true, c: (p) => inr(p.netPay) }, { h: 'Issued', c: (p) => (p.issuedAt ? fmtDateTime(p.issuedAt) : '—') }, { h: '', c: (p) => <a href={`/dl/payslip/${p.id}`}>PDF</a> },
          ]} empty="No payslips have been issued to you yet." />
        </Card>
      )}
    </Page>
  );
}
