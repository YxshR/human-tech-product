import type { ImportView } from '@humantech/contracts';
import { can, loadOr404, type PageProps } from '@/lib/data';
import { ActionButton, Card, KV, Page, Pill, Table, fmtDateTime, humanize } from '@/components/ui';
import { importTone } from '@/lib/tones';

export const metadata = { title: 'Import' };

export default async function ImportPage({ params, searchParams }: PageProps<{ id: string }>) {
  const { id } = await params; const sp = await searchParams;
  const i = await loadOr404<ImportView>(`/imports/${id}`);
  const commit = await can('import.commit');
  const back = `/imports/${id}`;
  return (
    <Page title={`Import ${humanize(i.importType)}`} sub={fmtDateTime(i.createdAt)} sp={sp} actions={<a className="btn" href="/imports">← All imports</a>}>
      <Card title="Result of the check" wide>
        <KV items={[['Status', <Pill key="s" tone={importTone(i.status)}>{humanize(i.status)}</Pill>], ['Rows in file', String(i.totalRows ?? '—')], ['Ready to import', String(i.acceptedRows ?? '—')], ['With problems', String(i.rejectedRows ?? '—')], ['Skipped duplicates', String(i.skippedRows)], ['If a duplicate is found', i.duplicatePolicy === 'skip' ? 'Skip it' : 'Stop (counts as a problem)']]} />
        <div className="row">
          {commit && i.status === 'needs_confirmation' && (i.acceptedRows ?? 0) > 0 && <ActionButton path={`/imports/${id}/commit`} back={back} ok="Import finished" button={`Import ${i.acceptedRows} rows`} tone="primary" confirm="Import the good rows now? Rows with problems are left out." />}
          {(i.status === 'needs_confirmation' || i.status === 'uploaded') && <ActionButton path={`/imports/${id}/cancel`} back="/imports" ok="Import cancelled" button="Cancel import" tone="danger" />}
          {i.hasResult && <a className="btn" href={`/dl/import/${id}`}>Download result file</a>}
        </div>
      </Card>
      {i.errors.length > 0 && (
        <Card title="Problems to fix" wide>
          <Table rows={i.errors} cols={[{ h: 'Row', right: true, c: (e) => e.row }, { h: 'Problem', c: (e) => e.messages.join('; ') }]} empty="" />
          <p className="muted">Fix these in your file and upload it again. Only the first problems are shown.</p>
        </Card>
      )}
    </Page>
  );
}
