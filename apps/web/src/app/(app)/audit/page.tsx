import type { AuditView } from '@humantech/contracts';
import { loadPaged, type PageProps } from '@/lib/data';
import { Card, Page, Pager, Table, fmtDateTime, NoAccess, Empty, humanize } from '@/components/ui';

export const metadata = { title: 'Audit log' };

export default async function Audit({ searchParams }: PageProps) {
  const sp = await searchParams;
  const f = { entityType: sp.entityType || undefined, action: sp.action || undefined, from: sp.from || undefined, to: sp.to || undefined };
  const res = await loadPaged<AuditView>('/audit-logs', { ...f, cursor: sp.cursor, limit: '25' });
  return (
    <Page title="Audit log" sub="A permanent record of every change: who made it, when, and what it was before and after. Entries cannot be edited or deleted." sp={sp}>
      {res === null ? <NoAccess what="the audit log" /> : (
        <>
          <form className="row card" style={{ marginBottom: 16 }}>
            <label>What was changed<input name="entityType" defaultValue={f.entityType} placeholder="e.g. employees" /></label><label>Action<input name="action" defaultValue={f.action} placeholder="e.g. employee.update" /></label>
            <label>From<input type="date" name="from" defaultValue={f.from} /></label><label>To<input type="date" name="to" defaultValue={f.to} /></label><button className="btn">Show</button>{(f.entityType || f.action || f.from || f.to) && <a className="btn ghost" href="/audit">Clear</a>}
          </form>
          <Card wide>
            <Table rows={res.rows} cols={[
              { h: 'When', c: (a) => fmtDateTime(a.createdAt) }, { h: 'Who', c: (a) => <strong>{a.actorName ?? (a.source === 'system' ? 'humanTech operator' : 'System')}</strong> }, { h: 'What they did', c: (a) => <>{humanize(a.action.split('.').slice(1).join(' ') || a.action)}<div className="muted">{a.action}</div></> }, { h: 'On', c: (a) => humanize(a.entityType) },
              { h: 'Details', c: (a) => (
                <details className="more"><summary>Before and after</summary><div><pre className="plain">{JSON.stringify({ reason: a.reason, before: a.before, after: a.after, requestId: a.requestId }, null, 1)}</pre></div></details>
              ) },
            ]} empty={<Empty icon="history" title="No entries match">Change or clear the filters above.</Empty>} />
          </Card>
          <Pager base="/audit" query={f} nextCursor={res.next} started={!!sp.cursor} />
        </>
      )}
    </Page>
  );
}
