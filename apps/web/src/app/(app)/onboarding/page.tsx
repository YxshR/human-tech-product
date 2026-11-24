import type { TaskView, TemplateView } from '@humantech/contracts';
import { can, load, type PageProps } from '@/lib/data';
import Link from 'next/link';
import { ActionForm, Card, Empty, Page, Pill, Table, Tabs, fmtDate } from '@/components/ui';

export const metadata = { title: 'Onboarding' };

export default async function Onboarding({ searchParams }: PageProps) {
  const sp = await searchParams;
  const manage = await can('onboarding.manage');
  const tab = manage && sp.tab === 'templates' ? 'templates' : 'tasks';
  const back = `/onboarding?tab=${tab}`;
  return (
    <Page title="Onboarding" sub={tab === 'tasks' ? 'Tasks assigned to you for people who are joining or leaving. Tick each off when it is done.' : 'Templates are the standard tasks copied onto every new joiner\u2019s (or leaver\u2019s) checklist.'} sp={sp}>
      {manage && <Tabs base="/onboarding" current={tab} items={[['tasks', 'My tasks'], ['templates', 'Checklist templates']]} />}
      {tab === 'tasks' ? <Tasks back={back} /> : <Templates back={back} />}
    </Page>
  );
}

async function Tasks({ back }: { back: string }) {
  const rows = await load<TaskView[]>('/onboarding/my-tasks');
  if (rows === null) return <Card><Empty icon="clipboard" title="No tasks for you">Onboarding tasks assigned to you appear here.</Empty></Card>;
  return (
    <Card wide>
      <Table rows={rows} cols={[
        { h: 'Task', c: (t) => <><strong>{t.title}</strong>{t.required ? <> <Pill tag>Required</Pill></> : null}</> }, { h: 'For', c: (t) => (t.phase === 'offboarding' ? 'Someone leaving' : 'A new joiner') }, { h: 'Due', c: (t) => fmtDate(t.dueDate) },
        { h: 'Status', c: (t) => <Pill tone={t.status === 'done' ? 'ok' : t.status === 'waived' ? undefined : 'warn'}>{t.status === 'pending' ? 'To do' : t.status}</Pill> },
        { h: '', c: (t) => <>
          <Link className="btn" href={`/employees/${t.employeeId}?tab=onboarding`}>Open employee</Link>
          {(t.status === 'pending' || t.status === 'in_progress') && <ActionForm inline method="PATCH" path={`/onboarding/tasks/${t.id}`} back={back} ok="Task marked as done" button="Mark as done" tone="primary" values={{ 's:status': 'done' }} />}
        </> },
      ]} empty={<Empty icon="clipboard" title="Nothing assigned to you">When someone joins or leaves and a task is yours, it appears here.</Empty>} />
    </Card>
  );
}

async function Templates({ back }: { back: string }) {
  const rows = (await load<TemplateView[]>('/onboarding/templates')) ?? [];
  return (
    <>
      <Card wide>
        <Table rows={rows} cols={[
          { h: 'Task', c: (t) => <><strong>{t.title}</strong><div className="muted">{t.code}</div></> }, { h: 'Used for', c: (t) => (t.phase === 'offboarding' ? 'Leavers' : 'New joiners') }, { h: 'Due', c: (t) => (t.dueOffsetDays === 0 ? 'On the start day' : t.dueOffsetDays > 0 ? `${t.dueOffsetDays} days after` : `${-t.dueOffsetDays} days before`) }, { h: 'Must be done', c: (t) => (t.required ? 'Yes' : 'Optional') },
          { h: 'Status', c: (t) => <Pill tone={t.active ? 'ok' : undefined}>{t.active ? 'In use' : 'Switched off'}</Pill> },
          { h: '', c: (t) => <ActionForm inline method="PATCH" path={`/onboarding/templates/${t.id}`} back={back} ok="Template updated" button={t.active ? 'Switch off' : 'Switch on'} values={{ 'b:active': String(!t.active) }} /> },
        ]} empty={<Empty icon="clipboard" title="No template tasks yet">Add the tasks every new joiner needs, such as “Collect ID proof” or “Issue laptop”.</Empty>} />
      </Card>
      <Card title="Add a template task" desc="It is copied onto a person's checklist when you create their checklist from templates.">
        <ActionForm path="/onboarding/templates" back={back} ok="Template task added" button="Add template task" fields={[
          { name: 's:title', label: 'Task', required: true, placeholder: 'e.g. Collect ID proof' }, { name: 's:code', label: 'Short code', required: true, hint: 'Unique, e.g. ID_PROOF' }, { name: 's:phase', label: 'Used for', kind: 'select', required: true, value: 'onboarding', options: [['onboarding', 'New joiners'], ['offboarding', 'Leavers']] },
          { name: 'n:dueOffsetDays', label: 'Due, in days from the start date', kind: 'number', value: 0, min: -30, max: 365, hint: '0 = on the day; negative = before' }, { name: 's:description', label: 'Instructions' }, { name: 's:ownerRoleKey', label: 'Role that does it', hint: 'Optional role key, e.g. hr_admin' },
          { name: 'b:required', label: 'Must be done before onboarding can be completed', kind: 'checkbox', value: true },
        ]} />
      </Card>
    </>
  );
}
