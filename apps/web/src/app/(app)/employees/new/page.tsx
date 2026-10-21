import { redirect } from 'next/navigation';
import { createEmployee, EMPLOYMENT_TYPES, type BranchView, type OrgItemView } from '@humantech/contracts';
import { api, ApiFailure } from '@/lib/api';
import { load, options, type PageProps } from '@/lib/data';
import { Card, Empty, Page, humanize } from '@/components/ui';
import { NewForm } from './form';

export const metadata = { title: 'Add employee' };

async function create(_prev: unknown, formData: FormData) {
  'use server';
  const raw = Object.fromEntries([...formData.entries()].filter(([k, v]) => !k.startsWith('$') && typeof v === 'string' && v !== ''));
  const parsed = createEmployee.safeParse(raw);
  if (!parsed.success) return { errors: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_form', i.message])) };
  let id: string;
  try {
    id = (await api<{ data: { id: string } }>('/employees', { method: 'POST', body: parsed.data })).data.id;
  } catch (e) {
    if (e instanceof ApiFailure) return { errors: { _form: e.message, ...Object.fromEntries((e.fields ?? []).map((f) => [f.path, f.message])) } };
    throw e;
  }
  redirect(`/employees/${id}?ok=Employee+added.+Next:+start+onboarding+below.&tab=onboarding`);
}

export default async function NewEmployee({ searchParams }: PageProps) {
  await searchParams;
  const branches = (await load<BranchView[]>('/branches')) ?? [];
  const departments = (await load<OrgItemView[]>('/org/departments')) ?? [];
  if (branches.length === 0) return <Page title="Add employee"><Card><Empty>Add a branch first (Organisation → Branches), then come back.</Empty></Card></Page>;
  return (
    <NewForm action={create}
      branches={options(branches.filter((b) => b.status === 'active'), (b) => b.id, (b) => `${b.name} (${b.code})`)}
      departments={options(departments.filter((d) => d.status === 'active'), (d) => d.id, (d) => d.name)}
      types={EMPLOYMENT_TYPES.map((t) => [t, humanize(t)])} />
  );
}
