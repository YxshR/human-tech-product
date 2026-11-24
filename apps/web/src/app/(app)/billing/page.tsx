import type { BillingView } from '@humantech/contracts';
import { load, type PageProps } from '@/lib/data';
import { Callout, Card, Empty, KV, Meter, NoAccess, Page, Pill, Table, fmtDate, inr } from '@/components/ui';

export const metadata = { title: 'Plan & billing' };

export default async function Billing({ searchParams }: PageProps) {
  const sp = await searchParams;
  const b = await load<BillingView>('/billing');
  const trialEnds = b?.subscription?.trialEndsAt;
  const onTrial = b?.subscription?.status === 'trialing' || b?.subscription?.status === 'trial';
  return (
    <Page title="Plan & billing" sub="The plan your company is on, how much of it you are using, and your invoices." sp={sp}>
      {b === null ? <NoAccess what="billing" /> : (
        <>
          {onTrial && trialEnds && <Callout title={`Your trial runs until ${fmtDate(trialEnds)}`}><p>Nothing is charged during the trial. We will contact you about billing before it ends.</p></Callout>}
          <div className="grid2" style={{ maxWidth: 900 }}>
            <Card title="Your plan" wide>
              <KV items={[
                ['Plan', <strong key="p">{b.plan?.name ?? 'No plan'}</strong>], ['Price', b.plan?.monthlyPrice ? `${inr(b.plan.monthlyPrice)} a month` : 'Free'], ['Status', b.subscription ? <Pill key="s">{b.subscription.status}</Pill> : '—'],
                ...(b.subscription?.currentPeriodEnd ? [['Renews on', fmtDate(b.subscription.currentPeriodEnd)] as [string, string]] : []),
              ]} />
              <p className="muted" style={{ marginTop: 16 }}>To move to a different plan, contact the humanTech team. Your data stays exactly where it is.</p>
            </Card>
            <Card title="Usage" desc="What you are using against your plan's limits." wide>
              <div className="stack">
                <Meter label="Active employees" used={b.usage.activeEmployees} limit={b.subscription?.employeeLimit ?? b.plan?.maxActiveEmployees} />
                <Meter label="Branches" used={b.usage.branches} limit={b.plan?.maxBranches} />
              </div>
            </Card>
          </div>
          <Card title="Invoices" wide>
            <Table caption="Invoices" rows={b.invoices} cols={[{ h: 'Invoice', c: (i) => i.invoiceNumber }, { h: 'For', c: (i) => `${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` }, { h: 'Amount', right: true, c: (i) => inr(i.amount) }, { h: 'Status', c: (i) => <Pill>{i.status}</Pill> }, { h: 'Issued', c: (i) => fmtDate(i.issuedAt) }]}
              empty={<Empty icon="card" title="No invoices yet">Invoices appear here once billing starts for your plan.</Empty>} />
          </Card>
        </>
      )}
    </Page>
  );
}
