import { z } from 'zod';
import { isoDate, uuid } from './common';

/** Leave quantities cross the API as decimal strings (half-day granularity in practice). */
export const leaveDays = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, 'expected a decimal string like "1.5"');
export const signedLeaveDays = z.string().regex(/^-?\d{1,4}(\.\d{1,2})?$/, 'expected a decimal string like "-1.5"');
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'letters, digits, - or _');

export const createLeaveType = z.object({
  code, name: z.string().trim().min(2).max(80),
  isPaid: z.boolean().default(true), requiresApproval: z.boolean().default(true), allowHalfDay: z.boolean().default(true),
  maxNegativeDays: leaveDays.default('0'),
}).strict();
export const updateLeaveType = z.object({
  name: z.string().trim().min(2).max(80).optional(), requiresApproval: z.boolean().optional(), allowHalfDay: z.boolean().optional(),
  maxNegativeDays: leaveDays.optional(), active: z.boolean().optional(),
}).strict();

export const ACCRUAL_FREQUENCIES = ['none', 'monthly', 'quarterly', 'yearly', 'on_joining'] as const;
export const createLeavePolicy = z.object({
  leaveTypeId: uuid, effectiveFrom: isoDate, effectiveTo: isoDate.nullish(),
  accrualFrequency: z.enum(ACCRUAL_FREQUENCIES), accrualDays: leaveDays,
  eligibleAfterDays: z.number().int().min(0).max(3650).default(0), probationEligible: z.boolean().default(true),
  carryForwardMaxDays: leaveDays.default('0'), expiryDays: z.number().int().min(1).max(3650).nullish(),
  countWeeklyOffs: z.boolean().default(false), countHolidays: z.boolean().default(false),
}).strict().refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { path: ['effectiveTo'], message: 'must not be before effectiveFrom' });

export const applyLeave = z.object({
  employeeId: uuid.optional(), leaveTypeId: uuid, startDate: isoDate, endDate: isoDate,
  partialDay: z.enum(['first_half', 'second_half']).nullish(), reason: z.string().trim().max(500).nullish(),
}).strict().refine((v) => v.endDate >= v.startDate, { path: ['endDate'], message: 'must not be before startDate' })
  .refine((v) => !v.partialDay || v.startDate === v.endDate, { path: ['partialDay'], message: 'a half day must be a single date' });
export const decideLeave = z.object({ version: z.number().int().positive(), comment: z.string().trim().max(500).optional() }).strict();
export const adjustBalance = z.object({
  employeeId: uuid, leaveTypeId: uuid, days: signedLeaveDays.refine((s) => Number(s) !== 0, 'must not be zero'),
  effectiveDate: isoDate, reason: z.string().trim().min(3).max(300), kind: z.enum(['manual_adjustment', 'opening_grant']).default('manual_adjustment'),
}).strict();
export const runAccrual = z.object({ asOf: isoDate.optional() }).strict();
export const runYearEnd = z.object({ year: z.number().int().min(2000).max(2100) }).strict();
export const leaveRequestQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), employeeId: uuid.optional(),
  from: isoDate.optional(), to: isoDate.optional(),
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type LeaveTypeView = { id: string; code: string; name: string; isPaid: boolean; requiresApproval: boolean; allowHalfDay: boolean; maxNegativeDays: string; active: boolean };
export type LeavePolicyView = {
  id: string; leaveTypeId: string; version: number; effectiveFrom: string; effectiveTo: string | null; accrualFrequency: string; accrualDays: string;
  eligibleAfterDays: number; probationEligible: boolean; carryForwardMaxDays: string; expiryDays: number | null;
  countWeeklyOffs: boolean; countHolidays: boolean; status: 'draft' | 'active' | 'retired';
};
export type LeaveRequestView = {
  id: string; employeeId: string; employeeNumber: string; employeeName: string; leaveTypeId: string; leaveTypeCode: string;
  startDate: string; endDate: string; partialDay: 'first_half' | 'second_half' | null; requestedDays: string; reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'; autoApproved: boolean; submittedAt: string;
  decidedBy: string | null; decidedAt: string | null; decisionComment: string | null; version: number;
};
export type LeaveBalanceView = { leaveTypeId: string; leaveTypeCode: string; leaveTypeName: string; balanceDays: string; pendingDays: string; availableDays: string };
export type LeaveLedgerEntry = { id: string; transactionType: string; daysDelta: string; effectiveDate: string; reason: string | null; sourceRequestId: string | null; createdAt: string };
