import { CUSTOM_ENTITIES, CUSTOM_VALUE_TYPES, VIEW_ENTITIES, type CustomFieldView, type ViewView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, Page, Pill, Table, Tabs, humanize } from '@/components/ui';

export const metadata = { title: 'Settings' };

export default async function Settings({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = sp.tab === 'views' ? 'views' : 'fields';
  return (
    <Page title="Settings" sp={sp}>
      <Tabs base="/settings" current={tab} items={[['fields', 'Custom fields'], ['views', 'Saved views']]} />
      {tab === 'fields' ? <Fields /> : <Views />}
    </Page>
  );
}

async function Fields() {
  const rows = await load<CustomFieldView[]>('/custom-fields');
  const manage = await can('custom_field.manage');
  const back = '/settings?tab=fields';
  if (rows === null) return <Empty>You do not have access.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'For', c: (f) => humanize(f.entityType) }, { h: 'Label', c: (f) => f.label }, { h: 'Key', c: (f) => f.internalKey }, { h: 'Type', c: (f) => humanize(f.valueType) }, { h: 'Options', c: (f) => f.options.join(', ') || '—' },
          { h: 'Status', c: (f) => <Pill tone={f.active ? 'ok' : undefined}>{f.active ? 'active' : 'hidden'}</Pill> },
          { h: '', c: (f) => manage && <ActionButton method="PATCH" path={`/custom-fields/${f.id}`} back={back} ok="Field updated" values={{ 'b:active': String(!f.active) }} button={f.active ? 'Hide' : 'Show'} /> },
        ]} empty="No custom fields yet." />
        <p className="muted">Hidden fields keep their saved values but disappear from forms.</p>
      </Card>
      {manage && (
        <Card title="Add a custom field">
          <ActionForm path="/custom-fields" back={back} ok="Field added" button="Add field" fields={[
            { name: 's:entityType', label: 'For', kind: 'select', required: true, options: CUSTOM_ENTITIES.map((e) => [e, humanize(e)]) }, { name: 's:label', label: 'Label', required: true },
            { name: 's:internalKey', label: 'Key', required: true, hint: 'lower-case letters, digits and _, e.g. blood_group' }, { name: 's:valueType', label: 'Type', kind: 'select', required: true, options: CUSTOM_VALUE_TYPES.map((t) => [t, humanize(t)]) },
            { name: 'l:options', label: 'Options (select types only, one per line)', kind: 'textarea' }, { name: 'b:required', label: 'Required', kind: 'checkbox', value: false },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Views() {
  const rows = await load<ViewView[]>('/views');
  const share = await can('view.manage_shared');
  const back = '/settings?tab=views';
  if (rows === null) return <Empty>You do not have access.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Name', c: (v) => v.name }, { h: 'For', c: (v) => humanize(v.entityType) }, { h: 'Columns', c: (v) => v.config.columns?.map(humanize).join(', ') ?? 'All' }, { h: 'Shared', c: (v) => (v.shared ? 'Yes' : 'Only me') },
          { h: '', c: (v) => (v.mine || share) && <ActionButton method="DELETE" path={`/views/${v.id}`} back={back} ok="View deleted" button="Delete" tone="danger" confirm="Delete this view?" /> },
        ]} empty="No saved views." />
      </Card>
      <Card title="Save a view">
        <ActionForm path="/views" back={back} ok="View saved" button="Save view" fields={[
          { name: 's:entityType', label: 'For', kind: 'select', required: true, options: Object.keys(VIEW_ENTITIES).map((e) => [e, humanize(e)]) }, { name: 's:name', label: 'Name', required: true },
          { name: 'l:config.columns', label: 'Columns (one per line)', kind: 'textarea', hint: Object.entries(VIEW_ENTITIES).map(([k, v]) => `${humanize(k)}: ${v.columns.join(', ')}`).join(' · ') },
          ...(share ? [{ name: 'b:shared', label: 'Share with everyone', kind: 'checkbox' as const, value: false }] : []),
        ]} />
        <p className="muted">A view remembers which columns you want. It does not change what you are allowed to see.</p>
      </Card>
    </>
  );
}
