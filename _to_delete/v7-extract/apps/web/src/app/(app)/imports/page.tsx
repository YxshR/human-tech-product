import { IMPORT_COLUMNS, IMPORT_TYPES, type ImportView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { importTone } from '@/lib/tones';
import { Card, Empty, Page, Pill, Table, UploadForm, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'Imports' };

export default async function Imports({ searchParams }: PageProps) {
  const sp = await searchParams;
  const rows = await load<ImportView[]>('/imports');
  const create = await can('import.create');
  const allowed = IMPORT_TYPES;
  return (
    <Page title="Imports" sub="Bring in many people at once from a CSV file" sp={sp}>
      {rows === null ? <Empty>You do not have access to imports.</Empty> : (
        <>
          {create && allowed.map((t) => (
            <Card key={t} title={`Import ${t}`}>
              <p className="muted">Required columns: {IMPORT_COLUMNS[t].required.join(', ')}. Optional: {IMPORT_COLUMNS[t].optional.join(', ')}. Up to 2000 rows. Nothing is saved until you confirm.</p>
              <div className="row">
                <UploadForm path={`/imports/${t}?duplicatePolicy=reject`} type="text/csv" accept=".csv,text/csv" back="/imports" then="/imports/{id}" ok="File checked" button="Check file (stop on duplicates)" />
                <UploadForm path={`/imports/${t}?duplicatePolicy=skip`} type="text/csv" accept=".csv,text/csv" back="/imports" then="/imports/{id}" ok="File checked" button="Check file (skip duplicates)" />
              </div>
            </Card>
          ))}
          <Card title="Recent imports" wide>
            <Table rows={rows} cols={[
              { h: 'Started', c: (i) => <a href={`/imports/${i.id}`}>{fmtDateTime(i.createdAt)}</a> }, { h: 'What', c: (i) => humanize(i.importType) }, { h: 'Rows', right: true, c: (i) => i.totalRows ?? '—' },
              { h: 'Good', right: true, c: (i) => i.acceptedRows ?? '—' }, { h: 'Problems', right: true, c: (i) => i.rejectedRows ?? '—' }, { h: 'Status', c: (i) => <Pill tone={importTone(i.status)}>{humanize(i.status)}</Pill> },
            ]} empty="No imports yet." />
          </Card>
        </>
      )}
    </Page>
  );
}
