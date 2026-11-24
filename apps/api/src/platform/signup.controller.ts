import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ROLES, ROLE_KEYS } from '@humantech/authz';
import { createMyCompany } from '@humantech/contracts';
import { NoTenant } from '../auth/decorators';
import { Database } from '../db';
import { ApiError } from '../common/errors';
import { parse } from '../common/zod';

const WINDOW_MS = 3_600_000;
const MAX_PER_WINDOW = 5;

/**
 * Self-service sign-up. A person who has signed in (Google or any OIDC provider) but belongs to no company picks a plan
 * and names their company; they become its administrator. No payment link, approval step or e-mail is involved.
 * Works before a company is selected (`@NoTenant`).
 */
@Controller('me')
export class SignupController {
  private readonly hits = new Map<string, number[]>();
  constructor(@Inject(Database) private readonly db: Database) {}

  @Post('company') @NoTenant() @HttpCode(201)
  async create(@Req() req: Request, @Body() body: unknown) {
    const userId = req.auth!.userId;
    const now = Date.now();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_PER_WINDOW) throw new ApiError('rate_limited', 429, 'Too many attempts. Please try again later.');
    this.hits.set(userId, [...recent, now]);

    const b = parse(createMyCompany, body);
    // Someone invited to an existing company, or who already created one, must not spawn another by accident.
    const has = await this.db.run({ userId }, (c) => c.query(`SELECT 1 FROM tenant_memberships WHERE user_id=$1 AND status='active' LIMIT 1`, [userId]));
    if (has.rowCount) throw new ApiError('conflict', 409, 'You already belong to a company.');

    const roles = ROLE_KEYS.map((key) => ({ key, name: ROLES[key].name, permissions: [...ROLES[key].permissions] }));
    const tenantId = await this.db.run({ userId }, async (c) =>
      (await c.query<{ t: string }>('SELECT app.create_company_for_user($1,$2,$3,$4::jsonb) AS t', [userId, b.companyName, b.planCode, JSON.stringify(roles)])).rows[0]!.t);
    return { data: { tenantId } };
  }
}
