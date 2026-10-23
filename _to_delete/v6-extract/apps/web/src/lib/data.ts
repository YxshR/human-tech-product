import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { api, ApiFailure } from './api';

export type Sp = { ok?: string; error?: string; tab?: string; cursor?: string; q?: string; status?: string; [k: string]: string | undefined };
export type PageProps<P = Record<string, never>> = { params: Promise<P>; searchParams: Promise<Sp> };
export interface Paged<T> { data: T[]; page: { nextCursor: string | null; limit: number } }

export const myself = cache(async (): Promise<{ permissions: string[]; employeeId: string | null }> => {
  const r = await api<{ data: { permissions: string[]; employeeId?: string | null } }>('/me/permissions').catch(() => ({ data: { permissions: [] as string[], employeeId: null } }));
  return { permissions: r.data.permissions, employeeId: r.data.employeeId ?? null };
});
export const myPermissions = cache(async (): Promise<Set<string>> => {
  const r = await api<{ data: { permissions: string[] } }>('/me/permissions').catch(() => ({ data: { permissions: [] as string[] } }));
  return new Set(r.data.permissions);
});
/** `can('a','b')` is true if the person holds any of them. */
export async function can(...keys: string[]): Promise<boolean> {
  const p = await myPermissions();
  return keys.some((k) => p.has(k));
}

/** "Own data" endpoints answer 422 for a login that has no employee record (e.g. a company administrator). */
const isNoEmployee = (e: ApiFailure) => e.status === 422 && !!e.fields?.some((f) => f.path === 'employeeId');

/** Reads `data` from the API. A refusal (403) or missing item (404) becomes `null` so the page can say so politely. */
export async function load<T>(path: string, query?: Record<string, string | undefined>): Promise<T | null> {
  try {
    return (await api<{ data: T }>(path, { query })).data;
  } catch (e) {
    if (e instanceof ApiFailure && (e.status === 403 || e.status === 404 || isNoEmployee(e))) return null;
    throw e;
  }
}
export async function loadPaged<T>(path: string, query?: Record<string, string | undefined>): Promise<{ rows: T[]; next: string | null } | null> {
  try {
    const r = await api<Paged<T>>(path, { query });
    return { rows: r.data, next: r.page?.nextCursor ?? null };
  } catch (e) {
    if (e instanceof ApiFailure && (e.status === 403 || e.status === 404 || isNoEmployee(e))) return null;
    throw e;
  }
}
export async function loadOr404<T>(path: string): Promise<T> {
  const r = await load<T>(path);
  if (r === null) notFound();
  return r;
}
export const options = <T,>(rows: T[] | null | undefined, v: (r: T) => string, l: (r: T) => string): Array<[string, string]> => (rows ?? []).map((r) => [v(r), l(r)]);
export const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);   // India date
export const thisMonth = () => today().slice(0, 7);
export const monthRange = (m: string): { from: string; to: string } => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return { from: `${m}-01`, to: `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}` };
};
export const isMonth = (m: string | undefined): m is string => !!m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

/** Up to 100 employees for a dropdown, in directory order. For long lists the person narrows by searching in Employees first. */
export async function employeeOptions(q?: string): Promise<Array<[string, string]>> {
  const r = await loadPaged<{ id: string; employeeNumber: string; firstName: string; lastName: string | null; employmentStatus: string }>('/employees', { limit: '100', q });
  return (r?.rows ?? []).filter((e) => e.employmentStatus !== 'archived' && e.employmentStatus !== 'exited').map((e) => [e.id, `${e.firstName} ${e.lastName ?? ''} (${e.employeeNumber})`.replace('  ', ' ')]);
}
