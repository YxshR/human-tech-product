import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiFailure } from '@/lib/api';
import { tenantCookie } from '@/lib/session';
import type { PageProps } from '@/lib/data';
import { Icon } from '@/components/icons';
import { SubmitButton } from '@/components/submit-button';

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
    <div className="auth-wrap">
      <main className="card" id="main">
        <div className="logo" aria-hidden="true">h</div>
        <h1>Join your company on humanTech</h1>
        {sp.error && <div className="flash err" role="alert" style={{ marginTop: 14 }}><Icon name="alert" size={18} /><div><strong>We could not use this invitation</strong><span>{sp.error}</span></div></div>}
        {valid ? (
          <>
            <p className="muted" style={{ marginTop: 8 }}>You have been invited to join a company. Accepting gives the account you are signed in with access to it. The roles your administrator chose decide what you will see.</p>
            <form action={accept} style={{ marginTop: 18 }}><input type="hidden" name="token" value={token} /><SubmitButton tone="primary">Accept invitation</SubmitButton></form>
            <div className="auth-foot"><span>Signed in with the wrong account? Sign out, then open the link in your email again.</span><form action="/auth/logout" method="post"><button className="btn ghost sm">Sign out</button></form></div>
          </>
        ) : (
          <>
            <div className="callout warn" style={{ marginTop: 14 }}><Icon name="alert" size={18} /><div><strong>This link is incomplete</strong><p>Part of the address is missing. Open the link from your invitation email again, or copy the whole link into your browser.</p></div></div>
            <div className="auth-foot"><span>Lost the email? Ask your administrator to send a new invitation.</span></div>
          </>
        )}
      </main>
    </div>
  );
}
