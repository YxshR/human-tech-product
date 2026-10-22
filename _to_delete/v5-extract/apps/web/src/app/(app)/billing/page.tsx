import type { BillingView } from '@humantech/contracts';
import { load, type PageProps } from '@/lib/data';
import { Card, Empty, KV, Page, Pill, Table, fmtDate, humanize, inr } from '@/components/ui';

export const metadata = { title: 'Billing' };

export default async function Billing({ searchParams }: PageProps) {
  const sp = await searchParams;
  const b = await load<BillingView>('/billing');
  return (
    <Page title="Billing" sub="Your humanTech plan and usage" sp={sp}>
      {b === null ? <Empty>You do not have access to billing.</Empty> : (
        <>
          <Card title="Plan">
            <KV items={[
              ['Plan', b.plan?.name ?? '—'], ['Price per month', b.plan?.monthlyPrice ? inr(b.plan.monthlyPrice) : '—'], ['Status', b.subscription ? humanize(b.subscription.status) : '—'],
              ['Trial ends', fmtDate(b.subscription?.trialEndsAt ?? null)], ['Current period ends', fmtDate(b.subscription?.currentPeriodEnd ?? null)],
              ['Active employees', `${b.usage.activeEmployees}${b.subscription?.employeeLimit ? ` of ${b.subscription.employeeLimit}` : ''}`], ['Branches', `${b.usage.branches}${b.plan?.maxBranches ? ` of ${b.plan.maxBranches}` : ''}`],
            ]} />
            <p className="muted">To change your plan, contact humanTech.</p>
          </Card>
          <Card title="Invoices" wide>
            <Table rows={b.invoices} cols={[{ h: 'Invoice', c: (i) => i.invoiceNumber }, { h: 'Period', c: (i) => `${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` }, { h: 'Amount', right: true, c: (i) => inr(i.amount) }, { h: 'Status', c: (i) => <Pill tone={i.status === 'paid' ? 'ok' : undefined}>{humanize(i.status)}</Pill> }, { h: 'Issued', c: (i) => fmtDate(i.issuedAt) }]} empty="No invoices yet." />
          </Card>
        </>
      )}
    </Page>
  );
}
