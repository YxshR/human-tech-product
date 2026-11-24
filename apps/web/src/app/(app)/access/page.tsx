import type { AccessUserView, BranchView, InvitationView, RoleView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Avatar, Callout, Card, Details, Empty, Page, Pill, Table, Tabs, fmtDateTime, humanize, NoAccess } from '@/components/ui';

export const metadata = { title: 'Users & roles' };
const TABS: Array<[string, string]> = [['users', 'People'], ['invitations', 'Invitations'], ['roles', 'Roles']];

export default async function Access({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'users';
  const back = `/access?tab=${tab}`;
  const roles = await load<RoleView[]>('/access/roles');
  const branches = (await load<BranchView[]>('/branches')) ?? [];
  return (
    <Page title="Users & roles" sub={tab === 'users' ? 'Everyone who can sign in to this company. A person\u2019s roles decide what they can see and do; branches limit which offices they see.' : tab === 'invitations' ? 'Invite people by email. They get a link, sign in, and receive the roles you chose.' : 'A role is a named set of permissions, such as HR admin or Manager. Give people roles rather than individual permissions.'} sp={sp}>
      <Tabs base="/access" current={tab} items={TABS} />
      {tab === 'users' && <Users back={back} roles={roles ?? []} branches={branches} />}
      {tab === 'invitations' && <Invitations back={back} roles={roles ?? []} branches={branches} />}
      {tab === 'roles' && <Roles back={back} roles={roles} />}
    </Page>
  );
}

/** `leave.approve` → "Leave: approve"; `salary.read_assignment` → "Salary: read assignment". */
const permLabel = (p: string) => { const [area = '', ...rest] = p.split('.'); return `${humanize(area)}: ${humanize(rest.join(' ')).toLowerCase()}`; };
const roleOptions = (roles: RoleView[]): Array<[string, string]> => roles.map((r) => [r.key, r.name]);
const scopeText = (s: 'all' | string[], branches: BranchView[]) => (s === 'all' ? 'All branches' : s.map((id) => branches.find((b) => b.id === id)?.name ?? 'a branch').join(', '));

async function Users({ back, roles, branches }: { back: string; roles: RoleView[]; branches: BranchView[] }) {
  const users = await load<AccessUserView[]>('/access/users');
  const manageRoles = await can('role.manage'); const manageUsers = await can('user.manage');
  if (users === null) return <NoAccess what="the user list" />;
  return (
    <Card wide>
      <Table rows={users} cols={[
        { h: 'Person', c: (u) => <span className="cell-main"><Avatar name={u.displayName || u.email} size="sm" soft /><span><strong>{u.displayName}</strong><div className="muted">{u.email}</div></span></span> },
        { h: 'Roles', c: (u) => u.roleKeys.map((k) => roles.find((r) => r.key === k)?.name ?? humanize(k)).join(', ') || '—' },
        { h: 'Branches', c: (u) => scopeText(u.branchScope, branches) },
        { h: 'Status', c: (u) => <Pill tone={u.status === 'active' ? 'ok' : 'warn'}>{u.status}</Pill> },
        // Actions
        { h: '', c: (u) => (
          <>
            {manageUsers && (u.status === 'active'
              ? <ActionButton path={`/access/users/${u.userId}/suspend`} back={back} ok="Access suspended" button="Suspend" tone="danger" confirm={`Suspend ${u.email}? They are signed out of this company and cannot get back in until you restore them. Nothing is deleted.`} />
              : <ActionButton path={`/access/users/${u.userId}/restore`} back={back} ok="Access restored" button="Restore" />)}
            {manageRoles && (
              <Details summary="Edit access">
                <ActionForm method="PUT" path={`/access/users/${u.userId}/roles`} back={back} ok={`Roles updated for ${u.email}`} button="Save roles" fields={[{ name: 'l:roleKeys', label: 'Roles', kind: 'multiselect', options: roleOptions(roles), value: u.roleKeys, hint: 'Tick every role this person should have.' }]} />
                <hr />
                <ActionForm method="PUT" path={`/access/users/${u.userId}/branch-scope`} back={back} ok={`Branch access updated for ${u.email}`} button="Save branches" fields={[{ name: 'a:scope', label: 'Branches they can see', kind: 'multiselect', options: branches.map((b) => [b.id, b.name]), value: u.branchScope === 'all' ? [] : u.branchScope, hint: 'Tick none to let them see all branches.' }]} />
              </Details>
            )}
          </>
        ) },
      ]} />
    </Card>
  );
}

async function Invitations({ back, roles, branches }: { back: string; roles: RoleView[]; branches: BranchView[] }) {
  const rows = await load<InvitationView[]>('/access/invitations');
  const invite = await can('user.invite');
  if (rows === null) return <NoAccess what="invitations" />;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Email', c: (i) => <strong>{i.email}</strong> }, { h: 'Roles', c: (i) => i.roleKeys.map((k) => roles.find((r) => r.key === k)?.name ?? humanize(k)).join(', ') }, { h: 'Branches', c: (i) => scopeText(i.branchScope, branches) },
          { h: 'Status', c: (i) => <Pill>{i.status === 'pending' ? 'Not accepted yet' : i.status}</Pill> }, { h: 'Link expires', c: (i) => (i.status === 'pending' ? fmtDateTime(i.expiresAt) : '—') },
          { h: '', c: (i) => invite && i.status === 'pending' && <ActionButton path={`/access/invitations/${i.id}/revoke`} back={back} ok="Invitation revoked" button="Revoke" tone="danger" confirm="Revoke this invitation?" /> },
        ]} empty={<Empty icon="users" title="No invitations yet">Invite your first colleague below.</Empty>} />
      </Card>
      {invite && (
        <Card title="Invite someone" desc="They receive an email with a personal link. It works for 7 days and only for the address you enter.">
          <ActionForm path="/access/invitations" back={back} ok="Invitation sent" button="Send invitation" fields={[
            { name: 's:email', label: 'Their email address', kind: 'email', required: true, placeholder: 'name@company.com' }, { name: 'l:roleKeys', label: 'Roles', kind: 'multiselect', options: roleOptions(roles), required: true, hint: 'Tick at least one. Not sure? “Employee” lets someone see only their own records.' },
            { name: 'a:branchScope', label: 'Branches they can see', kind: 'multiselect', options: branches.map((b) => [b.id, b.name]), hint: 'Tick none to let them see all branches.' },
          ]} />
          <Callout tone="plain"><p>After they join, link their sign-in to their employee record (Employees → open the person → Sign-in) so they can see their own leave, attendance and payslips.</p></Callout>
        </Card>
      )}
    </>
  );
}

async function Roles({ back, roles }: { back: string; roles: RoleView[] | null }) {
  const manage = await can('role.manage');
  const catalogue = manage ? await load<string[]>('/access/permissions') : null;
  if (roles === null) return <NoAccess what="roles" />;
  return (
    <>
      <Card wide>
        <Table rows={roles} cols={[
          { h: 'Role', c: (r) => <><strong>{r.name}</strong>{r.isSystem && <> <Pill tag>Built in</Pill></>}</> }, { h: 'People with it', right: true, c: (r) => r.memberCount },
          { h: 'What it allows', c: (r) => <Details summary={`${r.permissions.length} permissions`}><div className="muted" style={{ columnWidth: 220, fontSize: 13 }}>{r.permissions.map((p) => <div key={p}>{permLabel(p)}</div>)}</div></Details> },
          { h: '', c: (r) => manage && !r.isSystem && (
            <>
              <Details summary="Edit"><ActionForm method="PATCH" path={`/access/roles/${r.id}`} back={back} ok="Role updated" button="Save" fields={[{ name: 's:name', label: 'Name', value: r.name }, { name: 'l:permissions', label: 'Permissions', kind: 'multiselect', options: (catalogue ?? []).map((p) => [p, permLabel(p)]), value: r.permissions }]} /></Details>
              {r.memberCount === 0 && <ActionButton method="DELETE" path={`/access/roles/${r.id}`} back={back} ok="Role deleted" button="Delete" tone="danger" confirm={`Delete the role “${r.name}”? This cannot be undone.`} />}
            </>
          ) },
        ]} />
      </Card>
      {manage && catalogue && (
        <Card title="Create a custom role" desc="Built-in roles cover most needs and cannot be edited. Create your own when you need a different mix of permissions." wide>
          <ActionForm path="/access/roles" back={back} ok="Role created" button="Create role" fields={[
            { name: 's:name', label: 'Name', required: true, placeholder: 'e.g. Branch helper' }, { name: 's:key', label: 'Internal key', required: true, hint: 'Lowercase letters and underscores only, e.g. branch_helper. It cannot be changed later.' },
            { name: 'l:permissions', label: 'Permissions', kind: 'multiselect', options: catalogue.map((p) => [p, permLabel(p)]), required: true, hint: 'Each permission reads “area: what it allows”.' },
          ]} />
        </Card>
      )}
    </>
  );
}
