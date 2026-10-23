import { Inject, Injectable } from '@nestjs/common';
import { AuditView, auditQuery, decodeCursor, encodeCursor } from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { ApiError } from '../common/errors';

const like = (s: string) => `${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const invalid = (path: string, message: string) => new ApiError('validation_failed', 422, message, [{ path, message }]);

/** Read side of the append-only audit log. Values were redacted when written; this only filters and pages. */
@Injectable()
export class AuditViewerService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async list(a: RequestAuth, query: unknown): Promise<{ data: AuditView[]; nextCursor: string | null }> {
    const q = auditQuery.parse(query);
    const params: unknown[] = [a.tenantId]; const where = ['l.tenant_id=$1'];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.entityType) where.push(`l.entity_type=${add(q.entityType)}`);
    if (q.entityId) where.push(`l.entity_id=${add(q.entityId)}`);
    if (q.actorUserId) where.push(`l.actor_user_id=${add(q.actorUserId)}`);
    if (q.action) where.push(`l.action LIKE ${add(like(q.action))}`);
    if (q.from) where.push(`l.created_at >= (${add(q.from)}::date AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))`);
    if (q.to) where.push(`l.created_at < ((${add(q.to)}::date + 1) AT TIME ZONE (SELECT timezone FROM tenants WHERE id=$1))`);
    if (q.cursor) {
      let key: Array<string | number>;
      try { key = decodeCursor(q.cursor); } catch { throw invalid('cursor', 'invalid cursor'); }
      if (typeof key[0] !== 'string' || typeof key[1] !== 'string' || !/^[0-9a-f-]{36}$/.test(key[1]) || Number.isNaN(Date.parse(`${key[0]}Z`))) throw invalid('cursor', 'invalid cursor');
      where.push(`(l.created_at AT TIME ZONE 'UTC', l.id) < (${add(key[0])}::timestamp, ${add(key[1])}::uuid)`);
    }
    const limit = add(q.limit + 1);
    return this.db.run({ tenantId: a.tenantId, userId: a.userId }, async (c) => {
      const rows = (await c.query(
        `SELECT l.id, l.action, l.entity_type, l.entity_id, l.actor_user_id, u.display_name AS actor_name, l.reason, l.before_redacted, l.after_redacted, l.request_id, l.source, l.created_at,
                to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS key
           FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_user_id WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT ${limit}`, params)).rows;
      const page = rows.slice(0, q.limit); const last = page[page.length - 1];
      return {
        data: page.map((r) => ({
          id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, actorUserId: r.actor_user_id, actorName: r.actor_name, reason: r.reason,
          before: r.before_redacted, after: r.after_redacted, requestId: r.request_id, source: r.source, createdAt: (r.created_at as Date).toISOString(),
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor([last.key as string, last.id as string]) : null,
      };
    });
  }
}
