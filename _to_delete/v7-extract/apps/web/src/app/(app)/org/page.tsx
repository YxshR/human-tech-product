import type { BranchView, HolidayView, OrgItemView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, Page, Pill, Table, Tabs, fmtDate, dash } from '@/components/ui';

export const metadata = { title: 'Organisation' };
const TABS: Array<[string, string]> = [['branches', 'Branches'], ['departments', 'Departments'], ['designations', 'Designations'], ['cost-centres', 'Cost centres'], ['holidays', 'Holidays']];

export default async function Org({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'branches';
  const back = `/org?tab=${tab}`;
  const manage = await can('org.manage');
  return (
    <Page title="Organisation" sub="Branches, departments, designations, cost centres and holidays" sp={sp}>
      <Tabs base="/org" current={tab} items={TABS} />
      {tab === 'branches' ? <Branches back={back} /> : tab === 'holidays' ? <Holidays back={back} manage={manage} year={sp.year} /> : <Items resource={tab} back={back} manage={manage} />}
    </Page>
  );
}

async function Branches({ back }: { back: string }) {
  const rows = await load<BranchView[]>('/branches', { includeArchived: 'true' });
  const create = await can('branch.create'); const update = await can('branch.update');
  if (rows === null) return <Empty>You do not have access to branches.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (b) => b.code }, { h: 'Name', c: (b) => b.name }, { h: 'State', c: (b) => dash(b.stateCode) }, { h: 'Time zone', c: (b) => dash(b.timezone) },
          { h: 'Status', c: (b) => <Pill tone={b.status === 'active' ? 'ok' : undefined}>{b.status}</Pill> },
          { h: '', c: (b) => update && (b.status === 'active'
            ? <ActionForm inline method="PATCH" path={`/branches/${b.id}`} back={back} ok="Branch deactivated" fields={[{ name: 's:status', label: 'Status', kind: 'select', required: true, value: 'inactive', options: [['inactive', 'Make inactive'], ['archived', 'Archive']] }]} button="Apply" />
            : <ActionButton method="PATCH" path={`/branches/${b.id}`} back={back} ok="Branch reactivated" values={{ 's:status': 'active' }} button="Reactivate" />) },
        ]} />
      </Card>
      {create && (
        <Card title="Add a branch">
          <ActionForm path="/branches" back={back} ok="Branch added" button="Add branch" fields={[
            { name: 's:code', label: 'Code', required: true, maxLength: 30, hint: 'Short and unique, e.g. BLR-1' }, { name: 's:name', label: 'Name', required: true, maxLength: 120 },
            { name: 's:state_code', label: 'State code', maxLength: 2, hint: 'Two letters, e.g. KA (used for professional tax)' }, { name: 's:timezone', label: 'Time zone', placeholder: 'Asia/Kolkata' },
            { name: 's:address.line1', label: 'Address' }, { name: 's:address.city', label: 'City' }, { name: 's:address.postalCode', label: 'PIN code', maxLength: 12 },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Items({ resource, back, manage }: { resource: string; back: string; manage: boolean }) {
  const rows = await load<OrgItemView[]>(`/org/${resource}`, { includeArchived: 'true' });
  if (rows === null) return <Empty>You do not have access to this list.</Empty>;
  const label = resource === 'cost-centres' ? 'cost centre' : resource.slice(0, -1);
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (r) => r.code }, { h: 'Name', c: (r) => r.name }, { h: 'Status', c: (r) => <Pill tone={r.status === 'active' ? 'ok' : undefined}>{r.status}</Pill> },
          { h: '', c: (r) => manage && (r.status === 'active'
            ? <ActionButton method="PATCH" path={`/org/${resource}/${r.id}`} back={back} ok="Archived" values={{ 's:status': 'archived' }} confirm="Archive this? It will no longer be offered in lists." button="Archive" />
            : <ActionButton method="PATCH" path={`/org/${resource}/${r.id}`} back={back} ok="Restored" values={{ 's:status': 'active' }} button="Restore" />) },
        ]} empty={`No ${resource.replace('-', ' ')} yet.`} />
      </Card>
      {manage && <Card title={`Add a ${label}`}><ActionForm path={`/org/${resource}`} back={back} ok="Added" button="Add" fields={[{ name: 's:code', label: 'Code', required: true, maxLength: 30 }, { name: 's:name', label: 'Name', required: true, maxLength: 120 }]} /></Card>}
    </>
  );
}

async function Holidays({ back, manage, year }: { back: string; manage: boolean; year?: string }) {
  const y = year && /^\d{4}$/.test(year) ? year : String(new Date().getFullYear());
  const rows = await load<HolidayView[]>('/holidays', { year: y });
  const branches = (await load<BranchView[]>('/branches')) ?? [];
  if (rows === null) return <Empty>You do not have access to holidays.</Empty>;
  return (
    <>
      <form className="row card" style={{ marginBottom: 16 }}><input type="hidden" name="tab" value="holidays" /><label>Year<input name="year" defaultValue={y} inputMode="numeric" pattern="\d{4}" /></label><button className="btn">Show</button></form>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Date', c: (h) => fmtDate(h.holidayDate) }, { h: 'Holiday', c: (h) => h.name }, { h: 'Type', c: (h) => (h.isOptional ? 'Optional' : 'Fixed') },
          { h: 'Applies to', c: (h) => (h.branchId ? branches.find((b) => b.id === h.branchId)?.name ?? 'One branch' : 'All branches') },
          { h: '', c: (h) => manage && <ActionButton method="DELETE" path={`/holidays/${h.id}`} back={back} ok="Holiday removed" button="Remove" tone="danger" /> },
        ]} empty={`No holidays for ${y}.`} />
      </Card>
      {manage && (
        <Card title="Add a holiday">
          <ActionForm path="/holidays" back={back} ok="Holiday added" button="Add holiday" fields={[
            { name: 'd:holidayDate', label: 'Date', kind: 'date', required: true }, { name: 's:name', label: 'Name', required: true, maxLength: 120 },
            { name: 'b:isOptional', label: 'Optional holiday (employees pick a limited number)', kind: 'checkbox' },
            { name: 'z:branchId', label: 'Branch', kind: 'select', options: branches.map((b) => [b.id, b.name]), hint: 'Leave empty for all branches' },
          ]} />
        </Card>
      )}
    </>
  );
}
