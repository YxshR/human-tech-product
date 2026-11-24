import { z } from 'zod';

/** The three public plans: Free (small teams), Pro (paid) and Customize (tailored to the company). */
export const PLAN_CODES = ['free', 'pro', 'customize'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** A signed-in person creates their own company on a plan. No payment or approval step. */
export const createMyCompany = z.object({
  planCode: z.enum(PLAN_CODES),
  companyName: z.string().trim().min(2).max(200),
}).strict();
export type CreateMyCompany = z.infer<typeof createMyCompany>;
