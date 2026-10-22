import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getAccessToken, getTenantId } from '@/lib/session';

/**
 * Feeds the command palette. The browser asks this route; the route asks the API with the person's own token, so the API's
 * permission and branch-scope rules decide what can be found. A refusal simply means "no results" for that kind.
 */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 60);
  const empty = { employees: [], candidates: [] };
  const token = await getAccessToken();
  const tenant = await getTenantId();
  if (!token || !tenant || q.length < 2) return NextResponse.json(empty, { headers: { 'Cache-Control': 'private, no-store' } });
  const base = env('API_URL').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenant, Accept: 'application/json' };
  const get = async <T>(path: string): Promise<T[]> => {
    try {
      const r = await fetch(`${base}${path}?q=${encodeURIComponent(q)}&limit=6`, { headers, cache: 'no-store' });
      if (!r.ok) return [];
      return ((await r.json()) as { data?: T[] }).data ?? [];
    } catch { return []; }
  };
  const [emps, cands] = await Promise.all([
    get<{ id: string; employeeNumber: string; firstName: string; lastName: string | null; employmentStatus: string }>('/employees'),
    get<{ id: string; candidateCode: string; firstName: string; lastName: string | null; stage: string }>('/candidates'),
  ]);
  return NextResponse.json({
    employees: emps.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName ?? ''}`.trim(), number: e.employeeNumber, status: e.employmentStatus })),
    candidates: cands.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName ?? ''}`.trim(), code: c.candidateCode, stage: c.stage })),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
