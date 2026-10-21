import { z } from 'zod';
import { isoDate, uuid } from './common';

const code = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, - and _ only').transform((s) => s.toUpperCase());
const name = z.string().trim().min(1).max(120);
export const ORG_STATUSES = ['active', 'inactive', 'archived'] as const;

export const ORG_RESOURCES = ['departments', 'designations', 'cost-centres'] as const;
export type OrgResource = (typeof ORG_RESOURCES)[number];

export const createOrgItem = z.object({ code, name }).strict();
export const updateOrgItem = z.object({ name: name.optional(), status: z.enum(ORG_STATUSES).optional() }).strict();
export type OrgItemView = { id: string; code: string; name: string; status: (typeof ORG_STATUSES)[number] };

export const createBranch = z.object({
  code, name,
  state_code: z.string().trim().length(2).toUpperCase().optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
  address: z.object({ line1: z.string().max(200).optional(), city: z.string().max(100).optional(), postalCode: z.string().max(12).optional() }).strict().optional(),
}).strict();
export const updateBranch = createBranch.omit({ code: true }).partial().extend({ status: z.enum(ORG_STATUSES).optional() }).strict();
export type BranchView = { id: string; code: string; name: string; status: string; stateCode: string | null; timezone: string | null; address: Record<string, unknown> };

export const createHoliday = z.object({
  holidayDate: isoDate, name, isOptional: z.boolean().default(false), branchId: uuid.nullable().optional(),
}).strict();
export const holidayQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), branchId: uuid.optional() }).strict();
export type HolidayView = { id: string; holidayDate: string; name: string; isOptional: boolean; branchId: string | null };
