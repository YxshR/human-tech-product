import type { PoolClient } from 'pg';

export interface NotifyInput {
  tenantId: string;
  /** Users to tell. Duplicates and missing ids are ignored. */
  userIds: Array<string | null | undefined>;
  /** Stable key such as "leave.approved"; users can switch event keys off in their preferences. */
  eventKey: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  /** Same key => the user is told once (e.g. `leave-decision:${requestId}`). */
  dedupeKey?: string;
}

/** In-app notification inside the caller's transaction, so it exists exactly when the business change committed. */
export async function notify(c: PoolClient, n: NotifyInput): Promise<void> {
  const users = [...new Set(n.userIds.filter((u): u is string => !!u))];
  for (const u of users) {
    await c.query(
      `INSERT INTO notifications (tenant_id, recipient_user_id, event_key, title, body, data, dedupe_key)
       SELECT $1,$2,$3,$4,$5,$6,$7
        WHERE COALESCE((SELECT in_app_enabled FROM notification_preferences WHERE tenant_id=$1 AND user_id=$2 AND event_key=$3), true)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      [n.tenantId, u, n.eventKey, n.title, n.body ?? null, JSON.stringify(n.data ?? {}), n.dedupeKey ? `${n.dedupeKey}:${u}` : null]);
  }
}
