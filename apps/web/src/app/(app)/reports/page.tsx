import { REPORT_KEYS, type ExportView, type ReportResult } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionForm, Card, Empty, Page, Pill, Table, fmtDateTime, humanize, NoAccess } from '@/components/ui';

export const metadata = { title: 'Reports' };
type Cat = { key: string; title: string; canExport: boolean };

export default async function Reports({ searchParams }: PageProps) {
  const sp = await searchParams;
  const cat = await load<Cat[]>('/reports');
  if (cat === null) return <Page title="Reports & exports" sub="Ready-made summaries of your people data." sp={sp}><NoAccess what="reports" /></Page>;
  const key = cat.find((c) => c.key === sp.key) ?? cat[0];
  const filters = { branchId: sp.branchId || undefined, from: sp.from || undefined, to: sp.to || undefined, asOf: sp.asOf || undefined, status: sp.status || undefined };
  const result = key && REPORT_KEYS.some((k) => k === key.key) ? await load<ReportResult>(`/reports/${key.key}`, filters).catch(() => null) : null;
  const exports = (await can('export.create')) ? await load<ExportView[]>('/exports') : null;
  const back = `/reports?key=${key?.key ?? ''}`;
  return (
    <Page title="Reports & exports" sub="Pick a report to see it on screen, or export it as a CSV file to open in Excel or Google Sheets." sp={sp}>
      <nav className="chips" aria-label="Choose a report" style={{ marginBottom: 16 }}>{cat.map((c) => <a key={c.key} aria-current={c.key === key?.key ? 'true' : undefined} href={`/reports?key=${c.key}`}>{c.title}</a>)}</nav>
      {key && (
        <>
          <form className="row card">
            <input type="hidden" name="key" value={key.key} />
            <label>From<input type="date" name="from" defaultValue={sp.from} /></label><label>To<input type="date" name="to" defaultValue={sp.to} /></label>
            <label>As of date<input type="date" name="asOf" defaultValue={sp.asOf} /></label><label>Status<input name="status" defaultValue={sp.status} placeholder="e.g. active" /></label>
            <button className="btn">Apply filters</button><span className="hint" style={{ flexBasis: '100%' }}>All filters are optional. Each report uses the ones that make sense for it.</span>
          </form>
          {result === null ? <Card wide><Empty icon="chart" title="This report could not be run">These filters do not fit this report. Clear them and try again.</Empty></Card> : (
            <Card title={result.title} wide action={key.canExport ? (
                <ActionForm inline path="/exports" back={back} ok="Export started. Download it from “My exports” below." button="Export to CSV" values={{ 's:reportKey': key.key, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [`s:filters.${k}`, v as string])) }} />
              ) : undefined}>
              <Table rows={result.rows} cols={result.columns.map((c) => ({ h: c.label, c: (r: Record<string, string | number | null>) => String(r[c.key] ?? '—') }))} empty={<Empty icon="chart" title="Nothing to report">No data matches yet.</Empty>} />
              {result.truncated && <p className="muted" style={{ marginTop: 12 }}>Only the first rows are shown here. Export the report to get all of them.</p>}
            </Card>
          )}
        </>
      )}
      {exports && (
        <Card title="My exports" desc="Exports are prepared in the background. Refresh this page if one is still being prepared." wide>
          <Table rows={exports} cols={[
            { h: 'Report', c: (e) => humanize(e.reportKey) }, { h: 'Created', c: (e) => fmtDateTime(e.createdAt) }, { h: 'Rows', right: true, c: (e) => e.rowCount ?? '—' },
            { h: 'Status', c: (e) => <Pill tone={e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'bad' : 'warn'}>{e.status === 'completed' ? 'Ready' : e.status === 'failed' ? 'Failed' : 'Being prepared'}</Pill> }, { h: '', c: (e) => e.status === 'completed' && <a className="btn" href={`/dl/export/${e.id}`}>Download CSV</a> },
          ]} empty={<Empty icon="download" title="No exports yet">Run a report above and press “Export to CSV”.</Empty>} />
        </Card>
      )}
    </Page>
  );
}
