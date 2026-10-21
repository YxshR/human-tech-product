import { redirect } from 'next/navigation';
import { createEmployee } from '@humantech/contracts';
import { api, ApiFailure } from '@/lib/api';
import { NewForm } from './form';

export const metadata = { title: 'Add employee' };


async function create(_prev: unknown, formData: FormData) {
  'use server';
  const raw = Object.fromEntries([...formData.entries()].filter(([, v]) => v !== ''));
  const parsed = createEmployee.safeParse(raw);
  if (!parsed.success) return { errors: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) };
  try {
    const res = await api<{ data: { id: string } }>('/employees', { method: 'POST', body: parsed.data });
    redirect(`/employees/${res.data.id}`);
  } catch (e) {
    if (e instanceof ApiFailure) return { errors: { _form: e.message, ...Object.fromEntries((e.fields ?? []).map((f) => [f.path, f.message])) } };
    throw e;
  }
}

export default async function NewEmployee() {
  // Branch list endpoint arrives with the organisation module; until then the id is entered directly.
  return <NewForm action={create} />;
}

