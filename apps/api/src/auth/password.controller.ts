import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { activateLogin, passwordLogin } from '@humantech/contracts';
import { Database } from '../db';
import { ApiError, notFound } from '../common/errors';
import { parse } from '../common/zod';
import { Public } from './decorators';
import { LOCAL_AUTH, LocalAuth, burnPasswordCheck, hashPassword, loginCodeHash, verifyPassword } from './local-auth';

const WINDOW_MS = 15 * 60_000;
const MAX_PER_WINDOW = 20;
const WRONG = 'Wrong e-mail or password.';
const BAD_CODE = 'That e-mail and login code do not match, or the code has expired or been used. Check both, or ask your company for a new code.';

interface Found { user_id: string; identity_subject: string; display_name: string; password_hash: string; status: string; locked: boolean }
interface Activated { user_id: string; tenant_id: string; identity_subject: string; display_name: string }

/**
 * Sign-in with e-mail + password, and the first sign-in that turns a login code into a password.
 * Both routes are public by nature, so each is rate-limited per caller address, wrong passwords lock the account for a
 * while, and wrong codes cancel the code (see migration 0015). Answers never say whether an e-mail address is known.
 */
@Controller('auth/password')
export class PasswordController {
  private readonly hits = new Map<string, number[]>();
  constructor(@Inject(Database) private readonly db: Database, @Inject(LOCAL_AUTH) private readonly local: LocalAuth) {}

  private guard(req: Request, what: string): void {
    if (!this.local.enabled) throw notFound('password sign-in');
    const key = `${what}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_PER_WINDOW) throw new ApiError('rate_limited', 429, 'Too many attempts. Please wait a few minutes and try again.');
    this.hits.set(key, [...recent, now]);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.every((t) => now - t >= WINDOW_MS)) this.hits.delete(k);
  }

  @Post('login') @Public() @HttpCode(200)
  async login(@Req() req: Request, @Body() body: unknown) {
    this.guard(req, 'login');
    const b = parse(passwordLogin, body);
    const u = (await this.db.pool.query<Found>('SELECT * FROM app.password_login_find($1)', [b.email])).rows[0];
    if (!u) { await burnPasswordCheck(b.password); throw new ApiError('unauthenticated', 401, WRONG); }
    if (u.locked) { await burnPasswordCheck(b.password); throw new ApiError('rate_limited', 429, 'Too many wrong passwords. This account is locked for 15 minutes.'); }
    const ok = await verifyPassword(b.password, u.password_hash);
    await this.db.pool.query('SELECT app.password_login_record($1,$2)', [u.user_id, ok]);
    if (!ok) throw new ApiError('unauthenticated', 401, WRONG);
    if (u.status !== 'active') throw new ApiError('forbidden', 403, 'This account is disabled. Ask your company administrator.');
    return { data: await this.local.sign({ subject: u.identity_subject, email: b.email, name: u.display_name }) };
  }

  @Post('activate') @Public() @HttpCode(200)
  async activate(@Req() req: Request, @Body() body: unknown) {
    this.guard(req, 'activate');
    const b = parse(activateLogin, body);
    if (b.password.toLowerCase().includes(b.email.split('@')[0]!) && b.email.split('@')[0]!.length >= 4) {
      throw new ApiError('validation_failed', 422, 'Choose a password that does not contain your e-mail name.', [{ path: 'password', message: 'must not contain your e-mail name' }]);
    }
    const hash = await hashPassword(b.password);
    let row: Activated | undefined;
    try {
      row = (await this.db.run({}, (c) => c.query<Activated>('SELECT * FROM app.activate_login_code($1,$2,$3)', [b.email, loginCodeHash(b.email, b.code), hash]))).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code !== 'HT003') throw e;
      const m = String((e as Error).message);
      throw new ApiError('invalid_state', 409, /already has an account/.test(m)
        ? 'This e-mail address already has an account, so it cannot be set up again. Sign in with it, or ask your company administrator for help.'
        : /no longer be given a login/.test(m) ? 'This login code can no longer be used. Ask your company for a new one.' : BAD_CODE);
    }
    if (!row) throw new ApiError('invalid_state', 409, BAD_CODE);
    const session = await this.local.sign({ subject: row.identity_subject, email: b.email, name: row.display_name });
    return { data: { ...session, tenantId: row.tenant_id } };
  }
}
