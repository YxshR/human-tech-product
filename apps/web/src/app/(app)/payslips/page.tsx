import Link from 'next/link';
import { load, type PageProps } from '@/lib/data';
import { Card, Empty, Page, Pill, Table, fmtDate, inr } from '@/components/ui';
import { Icon } from '@/components/icons';

type MyPayslip = { id: string; periodCode: string; revision: number; status: string; netPay: string; issuedAt: string | null };
export const metadata = { title: 'My payslips' };

export default async function Payslips({ searchParams }: PageProps) {
  const sp = await searchParams;
  const rows = await load<MyPayslip[]>('/me/payslips');
  return (
    <Page title="My payslips" sub="One payslip for each month you were paid. Open one to see how your pay was worked out, or download it as a PDF." sp={sp}>
      {rows === null ? <Card><Empty icon="receipt" title="No payslips for this sign-in">Payslips appear here when your sign-in is linked to an employee record and your company runs payroll in humanTech. Ask HR if you expected to see one.</Empty></Card> : (
        <Card wide>
          <Table caption="My payslips" rows={rows} cols={[
            { h: 'Pay period', c: (p) => <><Link href={`/payslips/${p.id}`}><strong>{p.periodCode}</strong></Link>{p.revision > 1 && <> <Pill tone="info">Revised</Pill></>}</> },
            { h: 'Take-home pay', right: true, c: (p) => <strong>{inr(p.netPay)}</strong> }, { h: 'Issued on', c: (p) => fmtDate(p.issuedAt) },
            { h: '', c: (p) => <><Link className="btn" href={`/payslips/${p.id}`}>View</Link><a className="btn" href={`/dl/payslip/${p.id}`}><Icon name="download" size={14} />PDF</a></> },
          ]} empty={<Empty icon="receipt" title="No payslips yet">Your first payslip appears here after your company completes a pay run.</Empty>} />
        </Card>
      )}
    </Page>
  );
}
