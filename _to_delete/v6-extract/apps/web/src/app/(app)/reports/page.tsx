import { REPORT_KEYS, type ExportView, type ReportResult } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionForm, Card, Empty, Page, Pill, Table, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'Reports' };
type Cat = { key: string; title: string; canExport: boolean };

export default async function Reports({ searchParams }: PageProps) {
  const sp = await searchParams;
  const cat = await load<Cat[]>('/reports');
  if (cat === null) return <Page title="Reports" sp={sp}><Empty>You do not have access to reports.</Empty></Page>;
  const key = cat.find((c) => c.key === sp.key) ?? cat[0];
  const filters = { branchId: sp.branchId || undefined, from: sp.from || undefined, to: sp.to || undefined, asOf: sp.asOf || undefined, status: sp.status || undefined };
  const result = key && REPORT_KEYS.some((k) => k === key.key) ? await load<ReportResult>(`/reports/${key.key}`, filters).catch(() => null) : null;
  const exports = (await can('export.create')) ? await load<ExportView[]>('/exports') : null;
  const back = `/reports?key=${key?.key ?? ''}`;
  return (
    <Page title="Reports" sp={sp}>
      <div className="row">{cat.map((c) => <a key={c.key} className={`btn ${c.key === key?.key ? 'primary' : ''}`} href={`/reports?key=${c.key}`}>{c.title}</a>)}</div>
      {key && (
        <>
          <form className="row card" style={{ margin: '16px 0' }}>
            <input type="hidden" name="key" value={key.key} />
            <label>From<input type="date" name="from" defaultValue={sp.from} /></label><label>To<input type="date" name="to" defaultValue={sp.to} /></label>
            <label>As of<input type="date" name="asOf" defaultValue={sp.asOf} /></label><label>Status<input name="status" defaultValue={sp.status} /></label>
            <button className="btn">Apply</button>
          </form>
          {result === null ? <Empty>This report could not be run with these filters.</Empty> : (
            <Card title={result.title} wide>
              <Table rows={result.rows} cols={result.columns.map((c) => ({ h: c.label, c: (r: Record<string, string | number | null>) => String(r[c.key] ?? '—') }))} empty="No rows." />
              {result.truncated && <p className="muted">Showing the first rows only. Export the report to get everything.</p>}
              {key.canExport && (
                <ActionForm path="/exports" back={back} ok="Export created. Download it below." button="Export to CSV" values={{ 's:reportKey': key.key, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [`s:filters.${k}`, v as string])) }} />
              )}
            </Card>
          )}
        </>
      )}
      {exports && (
        <Card title="My exports" wide>
          <Table rows={exports} cols={[
            { h: 'Report', c: (e) => humanize(e.reportKey) }, { h: 'Created', c: (e) => fmtDateTime(e.createdAt) }, { h: 'Rows', right: true, c: (e) => e.rowCount ?? '—' },
            { h: 'Status', c: (e) => <Pill tone={e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'bad' : 'warn'}>{e.status}</Pill> }, { h: '', c: (e) => e.status === 'completed' && <a href={`/dl/export/${e.id}`}>Download</a> },
          ]} empty="No exports yet." />
        </Card>
      )}
    </Page>
  );
}
