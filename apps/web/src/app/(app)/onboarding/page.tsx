import type { TaskView, TemplateView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import { ActionForm, Card, Empty, Page, Pill, Table, Tabs, fmtDate, humanize } from '@/components/ui';

export const metadata = { title: 'Onboarding' };

export default async function Onboarding({ searchParams }: PageProps) {
  const sp = await searchParams;
  const manage = await can('onboarding.manage');
  const tab = manage && sp.tab === 'templates' ? 'templates' : 'tasks';
  const back = `/onboarding?tab=${tab}`;
  return (
    <Page title="Onboarding" sub="Checklists for people joining or leaving" sp={sp}>
      {manage && <Tabs base="/onboarding" current={tab} items={[['tasks', 'My tasks'], ['templates', 'Checklist templates']]} />}
      {tab === 'tasks' ? <Tasks back={back} /> : <Templates back={back} />}
    </Page>
  );
}

async function Tasks({ back }: { back: string }) {
  const rows = await load<TaskView[]>('/onboarding/my-tasks');
  if (rows === null) return <Empty>You have no onboarding tasks.</Empty>;
  return (
    <Card wide>
      <Table rows={rows} cols={[
        { h: 'Task', c: (t) => <>{t.title}{t.required ? <> <Pill>required</Pill></> : null}</> }, { h: 'Phase', c: (t) => humanize(t.phase) }, { h: 'Employee', c: (t) => <a href={`/employees/${t.employeeId}?tab=onboarding`}>Open</a> }, { h: 'Due', c: (t) => fmtDate(t.dueDate) },
        { h: 'Status', c: (t) => <Pill tone={t.status === 'done' ? 'ok' : t.status === 'waived' ? undefined : 'warn'}>{humanize(t.status)}</Pill> },
        { h: '', c: (t) => (t.status === 'pending' || t.status === 'in_progress') && (
          <ActionForm inline method="PATCH" path={`/onboarding/tasks/${t.id}`} back={back} ok="Task updated" button="Mark done" values={{ 's:status': 'done' }} />
        ) },
      ]} empty="Nothing assigned to you." />
    </Card>
  );
}

async function Templates({ back }: { back: string }) {
  const rows = (await load<TemplateView[]>('/onboarding/templates')) ?? [];
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Code', c: (t) => t.code }, { h: 'Task', c: (t) => t.title }, { h: 'Phase', c: (t) => humanize(t.phase) }, { h: 'Due (days from start)', right: true, c: (t) => t.dueOffsetDays }, { h: 'Required', c: (t) => (t.required ? 'Yes' : 'No') },
          { h: 'Status', c: (t) => <Pill tone={t.active ? 'ok' : undefined}>{t.active ? 'active' : 'off'}</Pill> },
          { h: '', c: (t) => <ActionForm inline method="PATCH" path={`/onboarding/templates/${t.id}`} back={back} ok="Template updated" button={t.active ? 'Switch off' : 'Switch on'} values={{ 'b:active': String(!t.active) }} /> },
        ]} empty="No templates yet." />
      </Card>
      <Card title="Add a template task">
        <ActionForm path="/onboarding/templates" back={back} ok="Template added" button="Add" fields={[
          { name: 's:code', label: 'Code', required: true }, { name: 's:title', label: 'Task', required: true }, { name: 's:phase', label: 'Phase', kind: 'select', required: true, value: 'onboarding', options: [['onboarding', 'Onboarding'], ['offboarding', 'Offboarding']] },
          { name: 's:description', label: 'Description' }, { name: 's:ownerRoleKey', label: 'Owner role (optional)' }, { name: 'n:dueOffsetDays', label: 'Due (days from start)', kind: 'number', value: 0, min: -30, max: 365 },
          { name: 'b:required', label: 'Required', kind: 'checkbox', value: true },
        ]} />
      </Card>
    </>
  );
}
