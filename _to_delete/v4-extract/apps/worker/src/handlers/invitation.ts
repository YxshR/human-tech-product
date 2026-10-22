import { PermanentJobError } from '@humantech/jobs';
import { z } from 'zod';
import { Mailer, escapeHtml } from '../mailer';
import type { Register } from './types';

const payload = z.object({ email: z.string().email(), token: z.string().min(16).optional(), expiresAt: z.string().datetime() });

/**
 * Sends the invitation e-mail, then erases the one-time token from the stored job.
 * Safe to run twice: the delivery row (unique per invitation) records that the mail already left.
 */
export const registerInvitation: Register = (runner, deps) => runner.register('invitation.email', async (job, ctx) => {
  const p = payload.safeParse(job.payload);
  if (!p.success) throw new PermanentJobError('invalid_payload', 'invitation payload is invalid');
  const key = `invitation:${job.aggregateId}`;

  const state = await ctx.tx(async (c) => {
    const inv = (await c.query<{ status: string; expires_at: Date; tenant_name: string; inviter: string | null }>(
      `SELECT i.status, i.expires_at, t.display_name AS tenant_name, u.display_name AS inviter
         FROM invitations i JOIN tenants t ON t.id=i.tenant_id LEFT JOIN users u ON u.id=i.invited_by
        WHERE i.tenant_id=$1 AND i.id=$2`, [job.tenantId, job.aggregateId])).rows[0];
    if (!inv) throw new PermanentJobError('invitation_missing', 'the invitation no longer exists');
    await c.query(
      `INSERT INTO notification_deliveries (tenant_id, channel, recipient, template_key, idempotency_key) VALUES ($1,'email',$2,'invitation',$3)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`, [job.tenantId, p.data.email, key]);
    const d = (await c.query<{ status: string }>('SELECT status FROM notification_deliveries WHERE tenant_id=$1 AND idempotency_key=$2', [job.tenantId, key])).rows[0]!;
    const usable = inv.status === 'pending' && inv.expires_at.getTime() > Date.now();
    if (!usable && d.status === 'pending') await c.query(`UPDATE notification_deliveries SET status='suppressed' WHERE tenant_id=$1 AND idempotency_key=$2`, [job.tenantId, key]);
    return { send: usable && d.status === 'pending', tenantName: inv.tenant_name, inviter: inv.inviter };
  });

  if (state.send) {
    if (!p.data.token) throw new PermanentJobError('token_missing', 'the invitation token is no longer available');
    const link = `${deps.webBaseUrl.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(p.data.token)}`;
    const by = state.inviter ? `${state.inviter} has invited you` : 'You have been invited';
    const until = new Date(p.data.expiresAt).toUTCString();
    let messageId: string;
    try {
      ({ messageId } = await send(deps.mailer, {
        to: p.data.email,
        subject: `Join ${state.tenantName} on humanTech`,
        text: `${by} to join ${state.tenantName} on humanTech.\n\nAccept the invitation: ${link}\n\nThis link works once and expires on ${until}. If you were not expecting this, ignore this e-mail.`,
        html: `<p>${escapeHtml(by)} to join <strong>${escapeHtml(state.tenantName)}</strong> on humanTech.</p><p><a href="${escapeHtml(link)}">Accept the invitation</a></p><p style="color:#666">This link works once and expires on ${escapeHtml(until)}. If you were not expecting this, ignore this e-mail.</p>`,
      }));
    } catch (e) {
      await ctx.tx((c) => c.query(`UPDATE notification_deliveries SET attempts=attempts+1, last_error_code='smtp_error' WHERE tenant_id=$1 AND idempotency_key=$2`, [job.tenantId, key]));
      throw e;
    }
    await ctx.tx((c) => c.query(`UPDATE notification_deliveries SET status='sent', sent_at=now(), attempts=attempts+1, provider_message_id=$3, last_error_code=NULL WHERE tenant_id=$1 AND idempotency_key=$2`, [job.tenantId, key, messageId]));
  }
  await ctx.scrub(['token']);          // the secret never outlives its use
});

const send = (m: Mailer, mail: Parameters<Mailer['send']>[0]) => m.send(mail);
