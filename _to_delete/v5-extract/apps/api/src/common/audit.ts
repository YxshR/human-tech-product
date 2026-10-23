import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { RequestAuth } from '../auth/auth-context';

/** Explicit, request-scoped audit entries for API actions (DB triggers cover the highest-risk tables separately). */
@Injectable()
export class AuditService {
  async record(c: PoolClient, auth: RequestAuth, action: string, entityType: string, entityId: string | null, before: unknown, after: unknown, reason?: string): Promise<void> {
    await c.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, reason, before_redacted, after_redacted, request_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'api')`,
      [auth.tenantId, auth.userId, action, entityType, entityId, reason ?? null,
        before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), auth.requestId],
    );
  }
}
