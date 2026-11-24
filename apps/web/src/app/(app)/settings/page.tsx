import { CUSTOM_ENTITIES, CUSTOM_VALUE_TYPES, VIEW_ENTITIES, type CustomFieldView, type ViewView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, Page, Pill, Table, Tabs, humanize, NoAccess } from '@/components/ui';

export const metadata = { title: 'Settings' };

export default async function Settings({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = sp.tab === 'views' ? 'views' : 'fields';
  return (
    <Page title="Settings" sub={tab === 'fields' ? 'Custom fields let you record extra information that humanTech does not have built in, such as blood group or T-shirt size.' : 'A saved view remembers which columns you like to see in a list or export.'} sp={sp}>
      <Tabs base="/settings" current={tab} items={[['fields', 'Custom fields'], ['views', 'Saved views']]} />
      {tab === 'fields' ? <Fields /> : <Views />}
    </Page>
  );
}

async function Fields() {
  const rows = await load<CustomFieldView[]>('/custom-fields');
  const manage = await can('custom_field.manage');
  const back = '/settings?tab=fields';
  if (rows === null) return <NoAccess what="this section" />;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Field', c: (f) => <><strong>{f.label}</strong><div className="muted">{f.internalKey}</div></> }, { h: 'Appears on', c: (f) => humanize(f.entityType) }, { h: 'Kind of answer', c: (f) => humanize(f.valueType) }, { h: 'Choices', c: (f) => f.options.join(', ') || '—' },
          { h: 'Status', c: (f) => <Pill tone={f.active ? 'ok' : undefined}>{f.active ? 'In use' : 'Hidden'}</Pill> },
          { h: '', c: (f) => manage && <ActionButton method="PATCH" path={`/custom-fields/${f.id}`} back={back} ok="Field updated" values={{ 'b:active': String(!f.active) }} button={f.active ? 'Hide' : 'Show'} /> },
        ]} empty={<Empty icon="sliders" title="No custom fields yet">{manage ? 'Add one below and it appears on every employee or candidate.' : 'An administrator can add them.'}</Empty>} />
        <p className="muted" style={{ marginTop: 12 }}>Hiding a field removes it from forms but keeps the answers already saved.</p>
      </Card>
      {manage && (
        <Card title="Add a custom field" desc="The new field appears on the “Custom fields” tab of every employee or candidate.">
          <ActionForm path="/custom-fields" back={back} ok="Field added" button="Add field" fields={[
            { name: 's:entityType', label: 'Appears on', kind: 'select', required: true, options: CUSTOM_ENTITIES.map((e) => [e, humanize(e)]) }, { name: 's:label', label: 'Label people see', required: true, placeholder: 'e.g. Blood group' },
            { name: 's:internalKey', label: 'Internal key', required: true, hint: 'Lowercase letters, digits and _ only, e.g. blood_group. Cannot be changed later.' }, { name: 's:valueType', label: 'Kind of answer', kind: 'select', required: true, options: CUSTOM_VALUE_TYPES.map((t) => [t, humanize(t)]) },
            { name: 'l:options', label: 'Choices', kind: 'textarea', hint: 'Only for single select and multi select. One choice per line.' }, { name: 'b:required', label: 'This field must be filled in', kind: 'checkbox', value: false },
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
  if (rows === null) return <NoAccess what="this section" />;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'View', c: (v) => <strong>{v.name}</strong> }, { h: 'List', c: (v) => humanize(v.entityType) }, { h: 'Columns', c: (v) => v.config.columns?.map(humanize).join(', ') ?? 'All columns' }, { h: 'Who sees it', c: (v) => (v.shared ? 'Everyone' : 'Only me') },
          { h: '', c: (v) => (v.mine || share) && <ActionButton method="DELETE" path={`/views/${v.id}`} back={back} ok="View deleted" button="Delete" tone="danger" confirm={`Delete the view “${v.name}”?`} /> },
        ]} empty={<Empty icon="layers" title="No saved views yet">Save one below.</Empty>} />
      </Card>
      <Card title="Save a view" desc="A view only remembers columns. It never shows anything you are not allowed to see.">
        <ActionForm path="/views" back={back} ok="View saved" button="Save view" fields={[
          { name: 's:entityType', label: 'List', kind: 'select', required: true, options: Object.keys(VIEW_ENTITIES).map((e) => [e, humanize(e)]) }, { name: 's:name', label: 'Name', required: true, placeholder: 'e.g. Contact sheet' },
          { name: 'l:config.columns', label: 'Columns, one per line', kind: 'textarea', hint: Object.entries(VIEW_ENTITIES).map(([k, v]) => `${humanize(k)}: ${v.columns.join(', ')}`).join(' · ') },
          ...(share ? [{ name: 'b:shared', label: 'Share with everyone', kind: 'checkbox' as const, value: false }] : []),
        ]} />
      </Card>
    </>
  );
}
