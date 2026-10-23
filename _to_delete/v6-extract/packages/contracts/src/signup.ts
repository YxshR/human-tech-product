import { z } from 'zod';

export const PLAN_CODES = ['plus', 'pro', 'customize'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
/** Public (no login) request for a company. `website` is a trap for bots: real people never see or fill it. */
export const createSignupRequest = z.object({
  planCode: z.enum(PLAN_CODES),
  companyName: trimmed(2, 200),
  contactName: trimmed(2, 120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: trimmed(5, 32).optional(),
  employeeCount: z.coerce.number().int().min(1).max(1_000_000).optional(),
  message: trimmed(1, 1000).optional(),
  website: z.string().max(200).optional(),
}).strict();
export type CreateSignupRequest = z.infer<typeof createSignupRequest>;
