import type { AuditView } from '@humantech/contracts';
import { loadPaged, type PageProps } from '@/lib/data';
import { Card, Empty, Page, Pager, Table, fmtDateTime } from '@/components/ui';

export const metadata = { title: 'Audit log' };

export default async function Audit({ searchParams }: PageProps) {
  const sp = await searchParams;
  const f = { entityType: sp.entityType || undefined, action: sp.action || undefined, from: sp.from || undefined, to: sp.to || undefined };
  const res = await loadPaged<AuditView>('/audit-logs', { ...f, cursor: sp.cursor, limit: '25' });
  return (
    <Page title="Audit log" sub="Who changed what, and when" sp={sp}>
      {res === null ? <Empty>You do not have access to the audit log.</Empty> : (
        <>
          <form className="row card" style={{ marginBottom: 16 }}>
            <label>Area<input name="entityType" defaultValue={f.entityType} placeholder="e.g. employees" /></label><label>Action<input name="action" defaultValue={f.action} placeholder="e.g. employee.update" /></label>
            <label>From<input type="date" name="from" defaultValue={f.from} /></label><label>To<input type="date" name="to" defaultValue={f.to} /></label><button className="btn">Filter</button>
          </form>
          <Card wide>
            <Table rows={res.rows} cols={[
              { h: 'When', c: (a) => fmtDateTime(a.createdAt) }, { h: 'Who', c: (a) => a.actorName ?? (a.source === 'system' ? 'humanTech operator' : '—') }, { h: 'Action', c: (a) => a.action }, { h: 'Area', c: (a) => a.entityType },
              { h: 'Details', c: (a) => (
                <details><summary>View</summary><pre className="plain">{JSON.stringify({ reason: a.reason, before: a.before, after: a.after, requestId: a.requestId }, null, 1)}</pre></details>
              ) },
            ]} empty="No entries." />
          </Card>
          <Pager base="/audit" query={f} nextCursor={res.next} />
        </>
      )}
    </Page>
  );
}
