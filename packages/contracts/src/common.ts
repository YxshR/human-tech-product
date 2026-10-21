import { z } from 'zod';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, 'not a real calendar date');
/** Money crosses the API as a decimal STRING, never a JSON number. */
export const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'expected a decimal string with up to 2 places');

/** Stable machine-readable error codes. Clients switch on `code`, never on `message`. */
export const ERROR_CODES = [
  'validation_failed', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'version_conflict',
  'invalid_state', 'maker_checker_violation', 'insufficient_balance', 'period_locked', 'rate_limited',
  'idempotency_key_reuse', 'payload_too_large', 'unsupported_media_type', 'mfa_required', 'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    requestId: z.string(),
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBody>;

/** Maps Postgres SQLSTATEs raised by DB-enforced controls to API errors (single place, tested). */
export const SQLSTATE_TO_ERROR: Record<string, { code: ErrorCode; status: number }> = {
  HT001: { code: 'invalid_state', status: 409 },
  HT002: { code: 'invalid_state', status: 409 },
  HT003: { code: 'invalid_state', status: 409 },
  HT004: { code: 'maker_checker_violation', status: 403 },
  HT005: { code: 'insufficient_balance', status: 409 },
  HT006: { code: 'period_locked', status: 409 },
  '23505': { code: 'conflict', status: 409 },
  '23503': { code: 'validation_failed', status: 422 },
  '23514': { code: 'validation_failed', status: 422 },
  '23P01': { code: 'conflict', status: 409 },
  '42501': { code: 'forbidden', status: 403 },
  '22P02': { code: 'validation_failed', status: 422 },
  '22008': { code: 'validation_failed', status: 422 },
  '22007': { code: 'validation_failed', status: 422 },
  '22003': { code: 'validation_failed', status: 422 },
  '22001': { code: 'validation_failed', status: 422 },
};

/** Cursor pagination: opaque cursor, bounded page size. No offset pagination on big tables. */
export const pageQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof pageQuery>;

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), page: z.object({ nextCursor: z.string().nullable(), limit: z.number().int() }) });

export const dataOf = <T extends z.ZodTypeAny>(item: T) => z.object({ data: item });

/** Opaque, tamper-evident-free cursor (it only carries sort keys; authorisation is re-applied on every page). */
export function encodeCursor(parts: Array<string | number>): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}
export function decodeCursor(cursor: string): Array<string | number> {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v;
  } catch { /* fallthrough */ }
  throw new Error('invalid cursor');
}
