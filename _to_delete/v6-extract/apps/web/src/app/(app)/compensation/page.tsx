import { COMPONENT_TYPES, STATUTORY_GROUPS, SUPPORTED_METHODS, type AssignmentView, type ComponentView, type StructureView } from '@humantech/contracts';
import { can, load, today, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Details, Empty, Page, Pill, Table, Tabs, dash, fmtDate, humanize, inr } from '@/components/ui';

export const metadata = { title: 'Compensation' };

export default async function Compensation({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tabs: Array<[string, string]> = [];
  if (await can('salary_structure.read')) tabs.push(['components', 'Pay components'], ['structures', 'Salary structures']);
  if (await can('salary.approve_assignment')) tabs.push(['pending', 'Salary changes to approve']);
  const tab = tabs.some(([k]) => k === sp.tab) ? sp.tab! : tabs[0]?.[0] ?? 'components';
  const back = `/compensation?tab=${tab}`;
  return (
    <Page title="Compensation" sub="What people are paid and how it is built up" sp={sp}>
      {tabs.length === 0 ? <Empty>You do not have access to compensation.</Empty> : (
        <>
          <Tabs base="/compensation" current={tab} items={tabs} />
          {tab === 'components' && <Components back={back} />}
          {tab === 'structures' && <Structures back={back} />}
          {tab === 'pending' && <Pending back={back} />}
        </>
      )}
    </Page>
  );
}

async function Components({ back }: { back: string }) {
  const rows = await load<ComponentView[]>('/compensation/components');
  const manage = await can('salary_structure.manage');
  if (rows === null) return <Empty>No access.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (c) => <strong>{c.code}</strong> }, { h: 'Label', c: (c) => c.label }, { h: 'Type', c: (c) => humanize(c.componentType) }, { h: 'Active', c: (c) => <Pill tone={c.active ? 'ok' : undefined}>{c.active ? 'yes' : 'no'}</Pill> },
          { h: 'Versions', c: (c) => (
            <Details summary={`${c.versions.length} version${c.versions.length === 1 ? '' : 's'}`}>
              <Table rows={c.versions} cols={[
                { h: 'v', right: true, c: (v) => v.version }, { h: 'Method', c: (v) => humanize(v.calculationMethod) },
                { h: 'Value', c: (v) => (v.defaultAmount ? inr(v.defaultAmount) : v.defaultPercentage ? `${v.defaultPercentage}% of ${v.baseComponentCodes.join(', ')}` : v.statutoryGroup ? humanize(v.statutoryGroup) : '—') },
                { h: 'From', c: (v) => fmtDate(v.effectiveFrom) }, { h: 'Status', c: (v) => <Pill tone={v.status === 'active' ? 'ok' : v.status === 'draft' ? 'warn' : undefined}>{v.status}</Pill> },
                { h: '', c: (v) => manage && (v.status === 'draft' ? <><ActionButton path={`/compensation/component-versions/${v.id}/activate`} back={back} ok="Version active" button="Activate" /><ActionButton method="DELETE" path={`/compensation/component-versions/${v.id}`} back={back} ok="Draft deleted" button="Delete" tone="danger" confirm="Delete this draft?" /></> : v.status === 'active' ? <ActionButton path={`/compensation/component-versions/${v.id}/retire`} back={back} ok="Version retired" button="Retire" tone="danger" confirm="Retire this version?" /> : null) },
              ]} />
              {manage && (
                <Details summary="Add a version">
                  <ActionForm path={`/compensation/components/${c.id}/versions`} back={back} ok="Version added as a draft" button="Add version" fields={[
                    { name: 's:calculationMethod', label: 'How it is worked out', kind: 'select', required: true, options: SUPPORTED_METHODS.map((m) => [m, humanize(m)]) },
                    { name: 's:defaultAmount', label: 'Amount (₹) — fixed or per-day', hint: 'e.g. 20000.00' }, { name: 's:defaultPercentage', label: 'Percentage — for percentage of component', hint: 'e.g. 40' },
                    { name: 'l:baseComponentCodes', label: 'Based on components (codes, comma separated)' }, { name: 's:statutoryGroup', label: 'Statutory group (statutory only)', kind: 'select', options: STATUTORY_GROUPS.map((g) => [g, humanize(g)]) },
                    { name: 'b:configuration.balance', label: 'Balancing figure up to monthly CTC (fixed only)', kind: 'checkbox' }, { name: 'b:isTaxable', label: 'Taxable', kind: 'checkbox', value: true }, { name: 'b:prorateOnUnpaidDays', label: 'Reduce for unpaid days', kind: 'checkbox', value: true },
                    { name: 's:roundingMode', label: 'Rounding', kind: 'select', required: true, value: 'half_up', options: [['half_up', 'Half up'], ['half_even', 'Half even'], ['down', 'Down'], ['up', 'Up']] }, { name: 'n:roundingPlaces', label: 'Decimal places', kind: 'number', value: 2, min: 0, max: 2 },
                    { name: 'd:effectiveFrom', label: 'Effective from', kind: 'date', required: true, value: today() }, { name: 'd:effectiveTo', label: 'Effective to', kind: 'date' },
                  ]} />
                </Details>
              )}
            </Details>
          ) },
        ]} empty="No components yet." />
      </Card>
      {manage && (
        <Card title="Add a component">
          <ActionForm path="/compensation/components" back={back} ok="Component added; now add a version" button="Add component" fields={[
            { name: 's:code', label: 'Code', required: true, hint: 'e.g. BASIC, HRA' }, { name: 's:label', label: 'Label', required: true }, { name: 's:componentType', label: 'Type', kind: 'select', required: true, options: COMPONENT_TYPES.map((t) => [t, humanize(t)]) },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Structures({ back }: { back: string }) {
  const rows = await load<StructureView[]>('/compensation/structures');
  const components = (await load<ComponentView[]>('/compensation/components')) ?? [];
  const manage = await can('salary_structure.manage');
  if (rows === null) return <Empty>No access.</Empty>;
  const versions = components.flatMap((c) => c.versions.filter((v) => v.status === 'active').map((v) => ({ id: v.id, code: c.code, label: c.label, v })));
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (s) => <strong>{s.code}</strong> }, { h: 'Name', c: (s) => s.name }, { h: 'Version', right: true, c: (s) => s.version }, { h: 'From', c: (s) => fmtDate(s.effectiveFrom) },
          { h: 'Components', c: (s) => <Details summary={`${s.components.length} components`}><Table rows={s.components} cols={[{ h: 'Component', c: (c) => `${c.componentCode} · ${c.label}` }, { h: 'Amount', right: true, c: (c) => (c.amount ? inr(c.amount) : c.percentage ? `${c.percentage}%` : 'default') }]} /></Details> },
          { h: 'Status', c: (s) => <Pill tone={s.status === 'active' ? 'ok' : s.status === 'draft' ? 'warn' : undefined}>{s.status}</Pill> },
          { h: '', c: (s) => manage && (s.status === 'draft' ? <ActionButton path={`/compensation/structures/${s.id}/activate`} back={back} ok="Structure active" button="Activate" /> : s.status === 'active' ? <><ActionButton path={`/compensation/structures/${s.id}/new-version`} back={back} ok="New draft version created" button="New version" /><ActionButton path={`/compensation/structures/${s.id}/retire`} back={back} ok="Structure retired" button="Retire" tone="danger" confirm="Retire this structure? People already on it keep it." /></> : null) },
        ]} empty="No salary structures yet." />
      </Card>
      {manage && (
        <Card title="Create a salary structure" wide>
          {versions.length === 0 ? <Empty>Add pay components and activate a version of each first.</Empty> : (
            <ActionForm path="/compensation/structures" back={back} ok="Structure created as a draft" button="Create structure" fields={[
              { name: 's:code', label: 'Code', required: true }, { name: 's:name', label: 'Name', required: true }, { name: 'd:effectiveFrom', label: 'Effective from', kind: 'date', required: true, value: today() }, { name: 'd:effectiveTo', label: 'Effective to', kind: 'date' },
            ]}>
              <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8 }}>
                <legend>Tick the components in this structure</legend>
                <div className="scroll"><table>
                  <thead><tr><th>Use</th><th>Component</th><th>Method</th><th>Amount override (₹)</th><th>Percent override</th><th>Order</th></tr></thead>
                  <tbody>
                    {versions.map((c, i) => (
                      <tr key={c.id}>
                        <td><input type="checkbox" name={`s:components.${i}._on`} value="on" aria-label={`Use ${c.code}`} /><input type="hidden" name={`s:components.${i}._row`} value="1" /><input type="hidden" name={`s:components.${i}.componentVersionId`} value={c.id} /></td>
                        <td>{c.code} · {c.label}</td><td>{humanize(c.v.calculationMethod)}{c.v.defaultAmount ? ` (${inr(c.v.defaultAmount)})` : ''}{c.v.defaultPercentage ? ` (${c.v.defaultPercentage}%)` : ''}</td>
                        <td><input name={`s:components.${i}.amount`} aria-label={`Amount for ${c.code}`} style={{ width: 110 }} /></td><td><input name={`s:components.${i}.percentage`} aria-label={`Percent for ${c.code}`} style={{ width: 80 }} /></td>
                        <td><input type="number" name={`n:components.${i}.displayOrder`} defaultValue={(i + 1) * 10} min={0} max={1000} aria-label={`Order for ${c.code}`} style={{ width: 70 }} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </fieldset>
            </ActionForm>
          )}
        </Card>
      )}
    </>
  );
}

async function Pending({ back }: { back: string }) {
  const rows = await load<AssignmentView[]>('/compensation/assignments/pending');
  if (rows === null) return <Empty>No access.</Empty>;
  return (
    <Card wide>
      <Table rows={rows} cols={[
        { h: 'Employee', c: (a) => a.employeeName }, { h: 'Structure', c: (a) => a.structureCode }, { h: 'From', c: (a) => fmtDate(a.effectiveFrom) }, { h: 'Monthly CTC', right: true, c: (a) => inr(a.monthlyCtc) }, { h: 'Why', c: (a) => dash(a.changeReason) },
        { h: '', c: (a) => <><ActionButton path={`/compensation/assignments/${a.id}/approve`} back={back} ok="Salary approved" button="Approve" /><ActionButton path={`/compensation/assignments/${a.id}/reject`} back={back} ok="Salary change rejected" button="Reject" tone="danger" /></> },
      ]} empty="Nothing is waiting for your approval." />
      <p className="muted">You cannot approve a change you proposed yourself.</p>
    </Card>
  );
}
