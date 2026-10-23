import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiFailure } from '@/lib/api';
import { tenantCookie } from '@/lib/session';
import type { PageProps } from '@/lib/data';

export const metadata = { title: 'Accept invitation' };

async function accept(formData: FormData) {
  'use server';
  const token = String(formData.get('token') ?? '');
  let tenantId: string;
  try {
    tenantId = (await api<{ data: { tenantId: string } }>('/access/invitations/accept', { method: 'POST', body: { token }, tenant: false })).data.tenantId;
  } catch (e) {
    if (e instanceof ApiFailure) redirect(`/accept-invite?token=${encodeURIComponent(token)}&error=${encodeURIComponent(e.status >= 500 ? 'Something went wrong. Please try again.' : 'This invitation link is not valid. It may have expired, been used already, or been sent to a different email address. Ask your administrator to send a new one.')}`);
    throw e;
  }
  (await cookies()).set(tenantCookie(tenantId));
  redirect('/dashboard?ok=Welcome!+You+now+have+access.');
}

export default async function AcceptInvite({ searchParams }: PageProps) {
  const sp = await searchParams;
  const token = sp.token ?? '';
  const valid = /^[A-Za-z0-9_-]{43}$/.test(token);
  return (
    <main className="main">
      <div className="card" style={{ maxWidth: 520 }}>
        <h1>Join your company on humanTech</h1>
        {sp.error && <p className="flash err" role="alert">{sp.error}</p>}
        {valid ? (
          <>
            <p>You have been invited to a company on humanTech. Accept to get access with the account you are signed in as.</p>
            <form action={accept}><input type="hidden" name="token" value={token} /><button className="btn primary">Accept invitation</button></form>
          </>
        ) : <p className="muted">This link is incomplete. Open the link from your invitation email again.</p>}
      </div>
    </main>
  );
}
