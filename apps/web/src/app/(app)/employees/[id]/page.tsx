import { notFound, redirect } from 'next/navigation';
import { updateEmployee, type EmployeeView } from '@humantech/contracts';
import { api, ApiFailure } from '@/lib/api';

export const metadata = { title: 'Employee' };

async function save(formData: FormData) {
  'use server';
  const id = String(formData.get('id'));
  const raw: Record<string, unknown> = { version: Number(formData.get('version')) };
  for (const k of ['firstName', 'lastName', 'workEmail']) {
    const v = String(formData.get(k) ?? '');
    if (v !== String(formData.get(`${k}__orig`) ?? '')) raw[k] = v;
  }
  const parsed = updateEmployee.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length < 2) redirect(`/employees/${id}`);
  try {
    await api(`/employees/${id}`, { method: 'PATCH', body: parsed.data });
  } catch (e) {
    if (e instanceof ApiFailure && e.code === 'version_conflict') redirect(`/employees/${id}?conflict=1`);
    throw e;
  }
  redirect(`/employees/${id}`);
}

async function archive(formData: FormData) {
  'use server';
  const id = String(formData.get('id'));
  await api(`/employees/${id}/archive`, { method: 'POST' });
  redirect('/employees');
}

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ conflict?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  let e: EmployeeView;
  try {
    e = (await api<{ data: EmployeeView }>(`/employees/${id}`)).data;
  } catch (err) {
    if (err instanceof ApiFailure && (err.status === 404 || err.status === 403)) notFound();
    throw err;
  }
  const perms = (await api<{ data: { permissions: string[] } }>('/me/permissions')).data.permissions;
  const canEdit = perms.includes('employee.update');
  return (
    <>
      <div className="topbar"><h1>{e.firstName} {e.lastName ?? ''}</h1><span className="pill">{e.employmentStatus.replace('_', ' ')}</span></div>
      {sp.conflict && <p className="err" role="alert">Someone else changed this record. Your edit was not saved — review the latest values and try again.</p>}
      <form action={save} className="form card">
        <input type="hidden" name="id" value={e.id} /><input type="hidden" name="version" value={e.version} />
        <p className="muted">Employee no. {e.employeeNumber}{e.joinedAt ? ` · joined ${e.joinedAt}` : ''}</p>
        {([['firstName', 'First name', e.firstName], ['lastName', 'Last name', e.lastName ?? ''], ['workEmail', 'Work email', e.workEmail ?? '']] as const).map(([k, label, v]) => (
          <label key={k}>{label}
            <input name={k} defaultValue={v} readOnly={!canEdit} />
            <input type="hidden" name={`${k}__orig`} value={v} />
          </label>
        ))}
        {e.phone !== undefined && <p className="muted">Phone: {e.phone ?? '—'}</p>}
        {canEdit && <button className="btn primary">Save changes</button>}
      </form>
      {perms.includes('employee.archive') && e.employmentStatus !== 'archived' && (
        <form action={archive} style={{ marginTop: 16 }}><input type="hidden" name="id" value={e.id} /><button className="btn">Archive employee</button></form>
      )}
    </>
  );
}
