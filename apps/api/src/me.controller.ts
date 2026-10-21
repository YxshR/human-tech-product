import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Database } from './db';
import { NoTenant } from './auth/decorators';

@Controller('me')
export class MeController {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Who am I, and which companies can I enter? Works before a company is selected. */
  @Get() @NoTenant()
  async me(@Req() req: Request) {
    const a = req.auth!;
    const companies = await this.db.run({ userId: a.userId }, async (c) =>
      (await c.query<{ id: string; name: string }>(
        `SELECT t.id, t.display_name AS name FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'active' ORDER BY t.display_name`, [a.userId])).rows);
    return { data: { userId: a.userId, email: a.email, companies } };
  }

  /** Permission keys for UI gating only; the server re-checks every request. */
  @Get('permissions')
  permissions(@Req() req: Request) {
    const a = req.auth!;
    return { data: { permissions: [...a.permissions].sort(), branchScope: a.branchScope.mode, mfaVerified: a.mfaVerified, employeeId: a.employeeId ?? null } };
  }
}
