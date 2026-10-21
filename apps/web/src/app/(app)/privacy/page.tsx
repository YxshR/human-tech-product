import { PRIVACY_REQUEST_TYPES, PRIVACY_TRANSITIONS, RETENTION_ENTITIES, type PrivacyRequestView, type RetentionView } from '@humantech/contracts';
import { can, employeeOptions, load, type PageProps } from '@/lib/data';
import { ActionForm, Card, Empty, Page, Pill, Table, Tabs, fmtDate, humanize } from '@/components/ui';

export const metadata = { title: 'Privacy' };

export default async function Privacy({ searchParams }: PageProps) {
  const sp = await searchParams;
  const manage = await can('privacy.manage');
  const tab = manage && sp.tab === 'retention' ? 'retention' : 'requests';
  return (
    <Page title="Privacy" sub="Requests about personal data, and how long data is kept" sp={sp}>
      {manage && <Tabs base="/privacy" current={tab} items={[['requests', 'Requests'], ['retention', 'Retention']]} />}
      {tab === 'requests' ? <Requests manage={manage} /> : <Retention />}
    </Page>
  );
}

async function Requests({ manage }: { manage: boolean }) {
  const rows = await load<PrivacyRequestView[]>('/privacy-requests');
  const people = manage ? await employeeOptions() : [];
  const back = '/privacy';
  if (rows === null) return <Empty>You do not have access.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Received', c: (r) => fmtDate(r.createdAt) }, { h: 'Type', c: (r) => humanize(r.requestType) }, { h: 'Details', c: (r) => r.details ?? '—' }, { h: 'Due', c: (r) => fmtDate(r.dueAt) },
          { h: 'Status', c: (r) => <><Pill tone={r.status === 'completed' ? 'ok' : r.status === 'rejected' ? 'bad' : 'warn'}>{humanize(r.status)}</Pill>{r.resolutionNote ? <div className="muted">{r.resolutionNote}</div> : null}</> },
          { h: '', c: (r) => manage && (PRIVACY_TRANSITIONS[r.status] ?? []).length > 0 && (
            <ActionForm inline path={`/privacy-requests/${r.id}/status`} back={back} ok="Request updated" button="Update" fields={[
              { name: 's:status', label: 'Move to', kind: 'select', required: true, options: (PRIVACY_TRANSITIONS[r.status] ?? []).map((s) => [s, humanize(s)]) }, { name: 's:resolutionNote', label: 'Note (needed to complete or reject)' },
            ]} />
          ) },
        ]} empty="No requests." />
        <p className="muted">Requests must be answered within 30 days. Completing an erasure request records the decision; removing data itself is done by the humanTech team.</p>
      </Card>
      <Card title={manage ? 'Log a request' : 'Make a request'}>
        <ActionForm path="/privacy-requests" back={back} ok="Request recorded" button="Submit" fields={[
          { name: 's:requestType', label: 'Type', kind: 'select', required: true, options: PRIVACY_REQUEST_TYPES.map((t) => [t, humanize(t)]) },
          ...(manage ? [{ name: 's:subjectEmployeeId', label: 'About employee (optional)', kind: 'select' as const, options: people }] : []),
          { name: 's:details', label: 'Details', kind: 'textarea' },
        ]} />
      </Card>
    </>
  );
}

async function Retention() {
  const rows = (await load<RetentionView[]>('/retention-policies')) ?? [];
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[{ h: 'Data', c: (r) => humanize(r.entityType) }, { h: 'Keep for (months)', right: true, c: (r) => r.retainMonths }, { h: 'Then', c: (r) => humanize(r.actionAfter) }, { h: 'Legal basis', c: (r) => r.legalBasis ?? '—' }]} empty="No retention rules set." />
        <p className="muted">Rules are recorded here. Applying them is a deliberate, reviewed step by the humanTech team; nothing is deleted automatically.</p>
      </Card>
      <Card title="Set a rule">
        <ActionForm method="PUT" path="/retention-policies" back="/privacy?tab=retention" ok="Retention rule saved" button="Save" fields={[
          { name: 's:entityType', label: 'Data', kind: 'select', required: true, options: RETENTION_ENTITIES.map((e) => [e, humanize(e)]) }, { name: 'n:retainMonths', label: 'Keep for (months)', kind: 'number', required: true, min: 1 },
          { name: 's:actionAfter', label: 'Then', kind: 'select', required: true, options: [['anonymise', 'Anonymise'], ['delete', 'Delete'], ['archive', 'Archive']] }, { name: 's:legalBasis', label: 'Legal basis' },
        ]} />
      </Card>
    </>
  );
}
