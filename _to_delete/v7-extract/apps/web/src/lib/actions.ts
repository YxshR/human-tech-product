'use server';
import { redirect } from 'next/navigation';
import { api, ApiFailure } from './api';
import { FormError, buildBody, safeApiPath, safePath, withParam } from './form-body';

/**
 * One server action for every form in the app. The form says what to call (`_path`, `_method`), where to go back to (`_back`)
 * and what to tell the person (`_ok`). The API still decides whether the person may do it.
 * `_then` can send them to a new page, with `{id}` replaced by the id of what was just created.
 */
export async function submit(fd: FormData): Promise<void> {
  const back = safePath(fd.get('_back'), '/');
  const path = safeApiPath(fd.get('_path'));
  const method = String(fd.get('_method') ?? 'POST').toUpperCase();
  const ok = String(fd.get('_ok') ?? 'Saved');
  const then = fd.get('_then');
  if (!path || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) redirect(withParam(back, 'error', 'This action is not available.'));
  let dest = withParam(back, 'ok', ok);
  try {
    const res = await api<{ data?: { id?: string } } | null>(path, { method, body: method === 'DELETE' ? undefined : buildBody(fd.entries()) });
    if (typeof then === 'string' && then.includes('{id}') && res?.data?.id) dest = safePath(then.replace('{id}', encodeURIComponent(res.data.id)), dest);
    else if (typeof then === 'string' && !then.includes('{id}')) dest = withParam(safePath(then, back), 'ok', ok);
  } catch (e) {
    if (e instanceof FormError) dest = withParam(back, 'error', `${e.path}: ${e.message}`);
    else if (e instanceof ApiFailure) dest = withParam(back, 'error', explain(e));
    else throw e;
  }
  redirect(dest);
}

/** Uploads the chosen file as raw bytes (documents, CSV imports). `_path` receives the file as the body. */
export async function upload(fd: FormData): Promise<void> {
  const back = safePath(fd.get('_back'), '/');
  const path = safeApiPath(fd.get('_path'));
  const file = fd.get('file');
  const ok = String(fd.get('_ok') ?? 'Uploaded');
  if (!path || !(file instanceof File) || file.size === 0) redirect(withParam(back, 'error', 'Choose a file first.'));
  let dest = withParam(back, 'ok', ok);
  try {
    const res = await api<{ data?: { id?: string } } | null>(path, { method: String(fd.get('_method') ?? 'POST'), rawBody: Buffer.from(await file.arrayBuffer()), contentType: String(fd.get('_type') ?? (file.type || 'application/octet-stream')) });
    const then = fd.get('_then');
    if (typeof then === 'string' && then.includes('{id}') && res?.data?.id) dest = safePath(then.replace('{id}', encodeURIComponent(res.data.id)), dest);
  } catch (e) {
    if (e instanceof ApiFailure) dest = withParam(back, 'error', explain(e)); else throw e;
  }
  redirect(dest);
}

function explain(e: ApiFailure): string {
  const fields = (e.fields ?? []).filter((f) => !e.message.includes(f.message)).slice(0, 4).map((f) => `${f.path ? `${f.path}: ` : ''}${f.message}`).join('; ');
  if (e.status === 403) return 'You do not have permission to do that.';
  return fields ? `${e.message} — ${fields}` : e.message;
}

/** Employee document upload: describe the file to the API (size and fingerprint are computed here), then send its bytes. */
export async function uploadDocument(fd: FormData): Promise<void> {
  const { createHash } = await import('node:crypto');
  const back = safePath(fd.get('_back'), '/');
  const employeeId = String(fd.get('employeeId') ?? '');
  const file = fd.get('file');
  if (!/^[0-9a-f-]{36}$/i.test(employeeId) || !(file instanceof File) || file.size === 0) redirect(withParam(back, 'error', 'Choose a file first.'));
  const bytes = Buffer.from(await file.arrayBuffer());
  const contentType = file.type;
  const expiresOn = String(fd.get('expiresOn') ?? '');
  let dest = withParam(back, 'ok', 'Document uploaded');
  try {
    const meta = {
      documentType: String(fd.get('documentType') ?? 'other'), ...(String(fd.get('title') ?? '').trim() ? { title: String(fd.get('title')).trim() } : {}),
      filename: file.name.replace(/[\\/\0]/g, '_').slice(0, 150) || 'document', contentType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(expiresOn ? { expiresOn } : {}),
    };
    const created = await api<{ data: { upload: { path: string } } }>(`/employees/${employeeId}/documents`, { method: 'POST', body: meta });
    await api(created.data.upload.path, { method: 'PUT', rawBody: bytes, contentType });
  } catch (e) {
    if (e instanceof ApiFailure) dest = withParam(back, 'error', explain(e)); else throw e;
  }
  redirect(dest);
}
