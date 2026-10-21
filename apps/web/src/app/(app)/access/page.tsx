import type { AccessUserView, BranchView, InvitationView, RoleView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionButton, ActionForm, Card, Details, Empty, Page, Pill, Table, Tabs, fmtDateTime, humanize } from '@/components/ui';

export const metadata = { title: 'Users & roles' };
const TABS: Array<[string, string]> = [['users', 'People'], ['invitations', 'Invitations'], ['roles', 'Roles']];

export default async function Access({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'users';
  const back = `/access?tab=${tab}`;
  const roles = await load<RoleView[]>('/access/roles');
  const branches = (await load<BranchView[]>('/branches')) ?? [];
  return (
    <Page title="Users & roles" sub="Who can sign in to this company and what they may do" sp={sp}>
      <Tabs base="/access" current={tab} items={TABS} />
      {tab === 'users' && <Users back={back} roles={roles ?? []} branches={branches} />}
      {tab === 'invitations' && <Invitations back={back} roles={roles ?? []} branches={branches} />}
      {tab === 'roles' && <Roles back={back} roles={roles} />}
    </Page>
  );
}

const roleOptions = (roles: RoleView[]): Array<[string, string]> => roles.map((r) => [r.key, r.name]);
const scopeText = (s: 'all' | string[], branches: BranchView[]) => (s === 'all' ? 'All branches' : s.map((id) => branches.find((b) => b.id === id)?.name ?? 'a branch').join(', '));

async function Users({ back, roles, branches }: { back: string; roles: RoleView[]; branches: BranchView[] }) {
  const users = await load<AccessUserView[]>('/access/users');
  const manageRoles = await can('role.manage'); const manageUsers = await can('user.manage');
  if (users === null) return <Empty>You do not have access to the user list.</Empty>;
  return (
    <Card wide>
      <Table rows={users} cols={[
        { h: 'Person', c: (u) => <><strong>{u.displayName}</strong><div className="muted">{u.email}</div></> },
        { h: 'Roles', c: (u) => u.roleKeys.map((k) => roles.find((r) => r.key === k)?.name ?? humanize(k)).join(', ') || '—' },
        { h: 'Branches', c: (u) => scopeText(u.branchScope, branches) },
        { h: 'Status', c: (u) => <Pill tone={u.status === 'active' ? 'ok' : 'warn'}>{u.status}</Pill> },
        { h: '', c: (u) => (
          <>
            {manageUsers && (u.status === 'active'
              ? <ActionButton path={`/access/users/${u.userId}/suspend`} back={back} ok="Access suspended" button="Suspend" tone="danger" confirm={`Suspend ${u.email}? They will be signed out of this company.`} />
              : <ActionButton path={`/access/users/${u.userId}/restore`} back={back} ok="Access restored" button="Restore" />)}
            {manageRoles && (
              <Details summary="Change roles & branches">
                <ActionForm method="PUT" path={`/access/users/${u.userId}/roles`} back={back} ok="Roles updated" button="Save roles" fields={[{ name: 'l:roleKeys', label: 'Roles (hold Ctrl/Cmd for several)', kind: 'multiselect', options: roleOptions(roles), value: u.roleKeys }]} />
                <hr />
                <ActionForm method="PUT" path={`/access/users/${u.userId}/branch-scope`} back={back} ok="Branch access updated" button="Save branches" fields={[{ name: 'a:scope', label: 'Branches (none selected = all)', kind: 'multiselect', options: branches.map((b) => [b.id, b.name]), value: u.branchScope === 'all' ? [] : u.branchScope }]} />
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
  if (rows === null) return <Empty>You do not have access to invitations.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Email', c: (i) => i.email }, { h: 'Roles', c: (i) => i.roleKeys.map(humanize).join(', ') }, { h: 'Branches', c: (i) => scopeText(i.branchScope, branches) },
          { h: 'Status', c: (i) => <Pill tone={i.status === 'pending' ? 'warn' : i.status === 'accepted' ? 'ok' : undefined}>{i.status}</Pill> }, { h: 'Expires', c: (i) => fmtDateTime(i.expiresAt) },
          { h: '', c: (i) => invite && i.status === 'pending' && <ActionButton path={`/access/invitations/${i.id}/revoke`} back={back} ok="Invitation revoked" button="Revoke" tone="danger" confirm="Revoke this invitation?" /> },
        ]} empty="No invitations yet." />
      </Card>
      {invite && (
        <Card title="Invite someone">
          <p className="muted">They receive an email with a link that works for 7 days and for their address only.</p>
          <ActionForm path="/access/invitations" back={back} ok="Invitation sent" button="Send invitation" fields={[
            { name: 's:email', label: 'Email', kind: 'email', required: true }, { name: 'l:roleKeys', label: 'Roles (hold Ctrl/Cmd for several)', kind: 'multiselect', options: roleOptions(roles), required: true },
            { name: 'a:branchScope', label: 'Branches (none selected = all)', kind: 'multiselect', options: branches.map((b) => [b.id, b.name]) },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Roles({ back, roles }: { back: string; roles: RoleView[] | null }) {
  const manage = await can('role.manage');
  const catalogue = manage ? await load<string[]>('/access/permissions') : null;
  if (roles === null) return <Empty>You do not have access to roles.</Empty>;
  return (
    <>
      <Card wide>
        <Table rows={roles} cols={[
          { h: 'Role', c: (r) => <><strong>{r.name}</strong>{r.isSystem && <> <Pill>built in</Pill></>}<div className="muted">{r.key}</div></> }, { h: 'People', right: true, c: (r) => r.memberCount },
          { h: 'Permissions', c: (r) => <Details summary={`${r.permissions.length} permissions`}><div className="muted" style={{ columnWidth: 220, fontSize: 13 }}>{r.permissions.map((p) => <div key={p}>{p}</div>)}</div></Details> },
          { h: '', c: (r) => manage && !r.isSystem && (
            <>
              <Details summary="Edit"><ActionForm method="PATCH" path={`/access/roles/${r.id}`} back={back} ok="Role updated" button="Save" fields={[{ name: 's:name', label: 'Name', value: r.name }, { name: 'l:permissions', label: 'Permissions', kind: 'multiselect', options: (catalogue ?? []).map((p) => [p, p]), value: r.permissions }]} /></Details>
              {r.memberCount === 0 && <ActionButton method="DELETE" path={`/access/roles/${r.id}`} back={back} ok="Role deleted" button="Delete" tone="danger" confirm="Delete this role?" />}
            </>
          ) },
        ]} />
      </Card>
      {manage && catalogue && (
        <Card title="Create a custom role">
          <ActionForm path="/access/roles" back={back} ok="Role created" button="Create role" fields={[
            { name: 's:key', label: 'Key', required: true, hint: 'lowercase letters and underscores, e.g. branch_helper' }, { name: 's:name', label: 'Name', required: true },
            { name: 'l:permissions', label: 'Permissions (hold Ctrl/Cmd for several)', kind: 'multiselect', options: catalogue.map((p) => [p, p]), required: true },
          ]} />
        </Card>
      )}
    </>
  );
}
