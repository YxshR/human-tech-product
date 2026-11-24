import { IMPORT_COLUMNS, IMPORT_TYPES, type ImportView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { importTone } from '@/lib/tones';
import { Empty, Card, Page, Pill, Table, UploadForm, fmtDateTime, humanize, NoAccess } from '@/components/ui';

export const metadata = { title: 'Imports' };

export default async function Imports({ searchParams }: PageProps) {
  const sp = await searchParams;
  const rows = await load<ImportView[]>('/imports');
  const create = await can('import.create');
  const allowed = IMPORT_TYPES;
  return (
    <Page title="Imports" sub="Add many employees or candidates at once from a spreadsheet saved as CSV. Nothing is saved until you have seen the check and confirmed it." sp={sp}>
      {rows === null ? <NoAccess what="imports" /> : (
        <>
          {create && allowed.map((t) => (
            <Card key={t} title={`Import ${t}`} desc="Step 1: choose your CSV file and we check every row. Step 2: you see what is good and what needs fixing. Step 3: you confirm, and only then is anything saved." wide>
              <dl className="changes" style={{ marginBottom: 16 }}>
                <div><dt>Columns you must have</dt><dd><code>{IMPORT_COLUMNS[t].required.join(', ')}</code></dd></div>
                <div><dt>Columns you may add</dt><dd><code>{IMPORT_COLUMNS[t].optional.join(', ')}</code></dd></div>
                <div><dt>Size</dt><dd>Up to 2,000 rows per file. The first row must be the column names.</dd></div>
              </dl>
              <div className="grid2" style={{ marginBottom: 0 }}>
                <div><h3>If a row is already in humanTech, stop</h3><p className="hint" style={{ marginBottom: 10 }}>Safest. Duplicates are reported as problems for you to look at.</p>
                  <UploadForm label="CSV file" path={`/imports/${t}?duplicatePolicy=reject`} type="text/csv" accept=".csv,text/csv" back="/imports" then="/imports/{id}" ok="File checked" button="Check this file" /></div>
                <div><h3>If a row is already in humanTech, skip it</h3><p className="hint" style={{ marginBottom: 10 }}>Use this to re-upload a file after adding new rows to it.</p>
                  <UploadForm label="CSV file" path={`/imports/${t}?duplicatePolicy=skip`} type="text/csv" accept=".csv,text/csv" back="/imports" then="/imports/{id}" ok="File checked" button="Check this file" /></div>
              </div>
            </Card>
          ))}
          <Card title="Recent imports" wide>
            <Table rows={rows} cols={[
              { h: 'Uploaded', c: (i) => <a href={`/imports/${i.id}`}><strong>{fmtDateTime(i.createdAt)}</strong></a> }, { h: 'What', c: (i) => humanize(i.importType) }, { h: 'Rows in file', right: true, c: (i) => i.totalRows ?? '—' },
              { h: 'Rows OK', right: true, c: (i) => i.acceptedRows ?? '—' }, { h: 'Rows with problems', right: true, c: (i) => i.rejectedRows ?? '—' }, { h: 'Status', c: (i) => <Pill tone={importTone(i.status)}>{i.status === 'needs_confirmation' ? 'Waiting for you to confirm' : humanize(i.status)}</Pill> },
              { h: '', c: (i) => <a className="btn" href={`/imports/${i.id}`}>{i.status === 'needs_confirmation' ? 'Review and confirm' : 'Open'}</a> },
            ]} empty={<Empty icon="upload" title="No imports yet">Files you upload appear here with their result.</Empty>} />
          </Card>
        </>
      )}
    </Page>
  );
}
