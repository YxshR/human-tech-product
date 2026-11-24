import type { BranchView, HolidayView, OrgItemView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Empty, Page, Pill, Table, Tabs, fmtDate, dash, NoAccess } from '@/components/ui';

export const metadata = { title: 'Organisation' };
const TABS: Array<[string, string]> = [['branches', 'Branches'], ['departments', 'Departments'], ['designations', 'Designations'], ['cost-centres', 'Cost centres'], ['holidays', 'Holidays']];

const HELP: Record<string, string> = {
  branches: 'Branches are your offices or locations. Every employee belongs to one, and access can be limited by branch.',
  departments: 'Departments group people by function, such as Sales or Finance. They are used in filters and reports.',
  designations: 'Designations are job titles, such as Accountant or Team lead.',
  'cost-centres': 'Cost centres let finance see which part of the business pays for a person.',
  holidays: 'Company holidays. They are not counted as leave days and show in attendance as a holiday.',
};

export default async function Org({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'branches';
  const back = `/org?tab=${tab}`;
  const manage = await can('org.manage');
  return (
    <Page title="Organisation" sub={HELP[tab]} sp={sp}>
      <Tabs base="/org" current={tab} items={TABS} />
      {tab === 'branches' ? <Branches back={back} /> : tab === 'holidays' ? <Holidays back={back} manage={manage} year={sp.year} /> : <Items resource={tab} back={back} manage={manage} />}
    </Page>
  );
}

async function Branches({ back }: { back: string }) {
  const rows = await load<BranchView[]>('/branches', { includeArchived: 'true' });
  const create = await can('branch.create'); const update = await can('branch.update');
  if (rows === null) return <NoAccess what="branches" />;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (b) => b.code }, { h: 'Name', c: (b) => b.name }, { h: 'State', c: (b) => dash(b.stateCode) }, { h: 'Time zone', c: (b) => dash(b.timezone) },
          { h: 'Status', c: (b) => <Pill>{b.status}</Pill> },
          { h: '', c: (b) => update && (b.status === 'active'
            ? <>
                <ActionButton method="PATCH" path={`/branches/${b.id}`} back={back} ok={`${b.name} is now inactive`} values={{ 's:status': 'inactive' }} button="Make inactive" confirm={`Make ${b.name} inactive? It stays on existing records but can no longer be chosen for new ones. You can reactivate it later.`} />
                <ActionButton method="PATCH" path={`/branches/${b.id}`} back={back} ok={`${b.name} archived`} values={{ 's:status': 'archived' }} button="Archive" tone="danger" confirm={`Archive ${b.name}? It is hidden from lists. Its history is kept.`} />
              </>
            : <ActionButton method="PATCH" path={`/branches/${b.id}`} back={back} ok={`${b.name} is active again`} values={{ 's:status': 'active' }} button="Reactivate" />) },
        ]} empty={<Empty icon="building" title="No branches yet">Add your first office or location below.</Empty>} />
      </Card>
      {create && (
        <Card title="Add a branch" desc="You need at least one branch before you can add employees.">
          <ActionForm path="/branches" back={back} ok="Branch added" button="Add branch" fields={[
            { name: 's:code', label: 'Code', required: true, maxLength: 30, hint: 'Short and unique, e.g. BLR-1' }, { name: 's:name', label: 'Name', required: true, maxLength: 120 },
            { name: 's:state_code', label: 'State code', maxLength: 2, hint: 'Two letters, e.g. KA. Used for professional tax.' }, { name: 's:timezone', label: 'Time zone', placeholder: 'Asia/Kolkata', hint: 'Leave empty for India time' },
            { name: 's:address.line1', label: 'Address: building, street' }, { name: 's:address.city', label: 'City' }, { name: 's:address.postalCode', label: 'PIN code', maxLength: 12 },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Items({ resource, back, manage }: { resource: string; back: string; manage: boolean }) {
  const rows = await load<OrgItemView[]>(`/org/${resource}`, { includeArchived: 'true' });
  if (rows === null) return <NoAccess what="this list" />;
  const label = resource === 'cost-centres' ? 'cost centre' : resource.slice(0, -1);
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (r) => r.code }, { h: 'Name', c: (r) => r.name }, { h: 'Status', c: (r) => <Pill>{r.status}</Pill> },
          { h: '', c: (r) => manage && (r.status === 'active'
            ? <ActionButton method="PATCH" path={`/org/${resource}/${r.id}`} back={back} ok="Archived" values={{ 's:status': 'archived' }} confirm="Archive this? It will no longer be offered in lists." button="Archive" />
            : <ActionButton method="PATCH" path={`/org/${resource}/${r.id}`} back={back} ok="Restored" values={{ 's:status': 'active' }} button="Restore" />) },
        ]} empty={<Empty icon="building" title={`No ${resource.replace('-', ' ')} yet`}>{manage ? `Add your first ${label} below.` : 'An administrator can add them.'}</Empty>} />
      </Card>
      {manage && <Card title={`Add a ${label}`}><ActionForm path={`/org/${resource}`} back={back} ok={`${label.charAt(0).toUpperCase()}${label.slice(1)} added`} button={`Add ${label}`} fields={[{ name: 's:code', label: 'Short code', required: true, maxLength: 30, hint: 'Unique, e.g. FIN' }, { name: 's:name', label: 'Name', required: true, maxLength: 120, placeholder: 'e.g. Finance' }]} /></Card>}
    </>
  );
}

async function Holidays({ back, manage, year }: { back: string; manage: boolean; year?: string }) {
  const y = year && /^\d{4}$/.test(year) ? year : String(new Date().getFullYear());
  const rows = await load<HolidayView[]>('/holidays', { year: y });
  const branches = (await load<BranchView[]>('/branches')) ?? [];
  if (rows === null) return <NoAccess what="holidays" />;
  return (
    <>
      <form className="row card" style={{ marginBottom: 16 }}><input type="hidden" name="tab" value="holidays" /><label>Year<input name="year" defaultValue={y} inputMode="numeric" pattern="\d{4}" /></label><button className="btn">Show year</button></form>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Date', c: (h) => fmtDate(h.holidayDate) }, { h: 'Holiday', c: (h) => h.name }, { h: 'Type', c: (h) => (h.isOptional ? 'Optional' : 'Fixed') },
          { h: 'Applies to', c: (h) => (h.branchId ? branches.find((b) => b.id === h.branchId)?.name ?? 'One branch' : 'All branches') },
          { h: '', c: (h) => manage && <ActionButton method="DELETE" path={`/holidays/${h.id}`} back={back} ok="Holiday removed" button="Remove" tone="danger" confirm={`Remove ${h.name} from the holiday list?`} /> },
        ]} empty={<Empty icon="calendar" title={`No holidays for ${y}`}>{manage ? 'Add the first one below.' : 'An administrator can add them.'}</Empty>} />
      </Card>
      {manage && (
        <Card title="Add a holiday">
          <ActionForm path="/holidays" back={back} ok="Holiday added" button="Add holiday" fields={[
            { name: 'd:holidayDate', label: 'Date', kind: 'date', required: true }, { name: 's:name', label: 'Name', required: true, maxLength: 120 },
            { name: 'b:isOptional', label: 'Optional holiday', kind: 'checkbox', hint: 'Employees choose a limited number of optional holidays' },
            { name: 'z:branchId', label: 'Branch', kind: 'select', placeholder: 'All branches', options: branches.map((b) => [b.id, b.name]) },
          ]} />
        </Card>
      )}
    </>
  );
}
