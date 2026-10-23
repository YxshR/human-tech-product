import { Inject, Injectable } from '@nestjs/common';
import { NOTIFICATION_EVENTS, NotificationView, PreferenceView, decodeCursor, encodeCursor, eventKey, notificationListQuery, setNotificationPreference } from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { ApiError, notFound } from '../common/errors';

const ctxOf = (a: RequestAuth) => ({ tenantId: a.tenantId, userId: a.userId });
const view = (r: Record<string, unknown>): NotificationView => ({
  id: r.id as string, eventKey: r.event_key as string, title: r.title as string, body: (r.body as string | null) ?? null, data: r.data as Record<string, unknown>,
  readAt: r.read_at ? (r.read_at as Date).toISOString() : null, createdAt: (r.created_at as Date).toISOString(),
});
const invalid = (path: string, message: string) => new ApiError('validation_failed', 422, message, [{ path, message }]);

/** Everyone's own notifications only: the recipient is always the caller, never a parameter. */
@Injectable()
export class NotificationsService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async list(a: RequestAuth, query: unknown): Promise<{ data: NotificationView[]; nextCursor: string | null; unread: number }> {
    const q = notificationListQuery.parse(query);
    const params: unknown[] = [a.tenantId, a.userId];
    const where = ['tenant_id=$1', 'recipient_user_id=$2'];
    if (q.unread) where.push('read_at IS NULL');
    if (q.cursor) {
      let key: Array<string | number>;
      try { key = decodeCursor(q.cursor); } catch { throw invalid('cursor', 'invalid cursor'); }
      if (typeof key[0] !== 'string' || typeof key[1] !== 'string' || !/^[0-9a-f-]{36}$/.test(key[1]) || Number.isNaN(Date.parse(`${key[0]}Z`))) throw invalid('cursor', 'invalid cursor');
      params.push(key[0], key[1]);
      where.push(`(created_at AT TIME ZONE 'UTC', id) < ($${params.length - 1}::timestamp, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    return this.db.run(ctxOf(a), async (c) => {
      const rows = (await c.query(
        `SELECT id, event_key, title, body, data, read_at, created_at, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS key
           FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params)).rows;
      const unread = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND recipient_user_id=$2 AND read_at IS NULL', [a.tenantId, a.userId])).rows[0]!.n;
      const page = rows.slice(0, q.limit); const last = page[page.length - 1];
      return { data: page.map(view), nextCursor: rows.length > q.limit && last ? encodeCursor([last.key as string, last.id as string]) : null, unread };
    });
  }

  async markRead(a: RequestAuth, id: string): Promise<NotificationView> {
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(
        `UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE tenant_id=$1 AND recipient_user_id=$2 AND id=$3 RETURNING id, event_key, title, body, data, read_at, created_at`, [a.tenantId, a.userId, id])).rows[0];
      if (!r) throw notFound('notification');
      return view(r);
    });
  }

  async markAllRead(a: RequestAuth): Promise<{ updated: number }> {
    return this.db.run(ctxOf(a), async (c) => ({
      updated: (await c.query('UPDATE notifications SET read_at=now() WHERE tenant_id=$1 AND recipient_user_id=$2 AND read_at IS NULL', [a.tenantId, a.userId])).rowCount ?? 0,
    }));
  }

  async preferences(a: RequestAuth): Promise<PreferenceView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      const saved = new Map((await c.query('SELECT event_key, in_app_enabled, email_enabled FROM notification_preferences WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, a.userId])).rows.map((r) => [r.event_key as string, r]));
      return NOTIFICATION_EVENTS.map((k) => ({ eventKey: k, inAppEnabled: saved.get(k)?.in_app_enabled ?? true, emailEnabled: saved.get(k)?.email_enabled ?? true }));
    });
  }

  async setPreference(a: RequestAuth, key: string, body: unknown): Promise<PreferenceView> {
    const k = eventKey.safeParse(key);
    if (!k.success || !(NOTIFICATION_EVENTS as readonly string[]).includes(k.data)) throw notFound('notification type');
    const b = setNotificationPreference.parse(body);
    return this.db.run(ctxOf(a), async (c) => {
      const r = (await c.query(
        `INSERT INTO notification_preferences (tenant_id, user_id, event_key, in_app_enabled, email_enabled) VALUES ($1,$2,$3,COALESCE($4,true),COALESCE($5,true))
         ON CONFLICT (tenant_id, user_id, event_key) DO UPDATE SET in_app_enabled=COALESCE($4, notification_preferences.in_app_enabled), email_enabled=COALESCE($5, notification_preferences.email_enabled)
         RETURNING event_key, in_app_enabled, email_enabled`, [a.tenantId, a.userId, k.data, b.inAppEnabled ?? null, b.emailEnabled ?? null])).rows[0]!;
      return { eventKey: r.event_key, inAppEnabled: r.in_app_enabled, emailEnabled: r.email_enabled };
    });
  }
}
