'use server';
import { redirect } from 'next/navigation';
import { env } from '@/lib/env';

const back = (plan: string, error: string): never => redirect(`/signup?plan=${encodeURIComponent(plan)}&error=${encodeURIComponent(error)}`);

/** Sends the request to the API (no login needed) and shows the "what happens next" screen. */
export async function requestCompany(fd: FormData): Promise<void> {
  const text = (k: string) => String(fd.get(k) ?? '').trim();
  const plan = text('planCode') || 'plus';
  const body: Record<string, unknown> = { planCode: plan, companyName: text('companyName'), contactName: text('contactName'), email: text('email'), website: text('website') };
  if (text('phone')) body.phone = text('phone');
  if (text('employeeCount')) body.employeeCount = Number(text('employeeCount'));
  if (text('message')) body.message = text('message');
  let status = 0;
  try {
    const r = await fetch(`${env('API_URL').replace(/\/$/, '')}/public/signup-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    status = r.status;
  } catch { return back(plan, 'We could not reach our servers. Please try again in a moment.'); }
  if (status === 202) redirect(`/signup?done=${encodeURIComponent(plan)}`);
  if (status === 422) return back(plan, 'Please check the form: company name, your name and a valid e-mail are required.');
  if (status === 429) return back(plan, 'Too many requests from your network. Please try again later.');
  return back(plan, 'Something went wrong on our side. Please try again.');
}
