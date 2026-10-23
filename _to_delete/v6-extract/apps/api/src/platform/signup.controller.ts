import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { createSignupRequest } from '@humantech/contracts';
import { Public } from '../auth/decorators';
import { Database } from '../db';
import { ApiError } from '../common/errors';
import { parse } from '../common/zod';

const WINDOW_MS = 3_600_000;
const MAX_PER_WINDOW = 10;

/** Public: anyone may ask for a company. Kept deliberately small: validated, rate-limited, insert-only. */
@Controller('public')
export class SignupController {
  private readonly hits = new Map<string, number[]>();
  constructor(@Inject(Database) private readonly db: Database) {}

  @Public() @Post('signup-requests') @HttpCode(202)
  async create(@Req() req: Request, @Body() body: unknown) {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_PER_WINDOW) throw new ApiError('rate_limited', 429, 'Too many requests. Please try again later.');
    this.hits.set(key, [...recent, now]);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < WINDOW_MS)) this.hits.delete(k);

    const b = parse(createSignupRequest, body);
    // A filled trap field gets the same answer as a real request, so bots learn nothing.
    if (!b.website) {
      await this.db.pool.query(
        `INSERT INTO signup_requests (plan_code, company_name, contact_name, email_normalized, phone, employee_count, message)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [b.planCode, b.companyName, b.contactName, b.email, b.phone ?? null, b.employeeCount ?? null, b.message ?? null]);
    }
    return { data: { received: true } };
  }
}
