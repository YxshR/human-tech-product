import { z } from 'zod';
import { money, uuid } from './common';

export const createPayGroup = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'letters, digits, - or _'),
  name: z.string().trim().min(2).max(80), frequency: z.enum(['monthly']).default('monthly'),
  periodStartDay: z.number().int().min(1).max(28).default(1), attendanceSource: z.enum(['attendance', 'full_pay']).default('attendance'),
  inputCutoffDay: z.number().int().min(1).max(31).nullish(), payDay: z.number().int().min(1).max(31).nullish(),
}).strict();
export const updatePayGroup = z.object({
  name: z.string().trim().min(2).max(80).optional(), attendanceSource: z.enum(['attendance', 'full_pay']).optional(),
  inputCutoffDay: z.number().int().min(1).max(31).nullish(), payDay: z.number().int().min(1).max(31).nullish(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
}).strict();
export const paySetup = z.object({ payGroupId: uuid.nullable(), payrollEligible: z.boolean() }).strict();
export const generatePeriod = z.object({ payGroupId: uuid, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();

export const createRun = z.object({ payrollPeriodId: uuid }).strict();
export const rejectRun = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
export const correctRun = z.object({ reason: z.string().trim().min(10).max(1000) }).strict();
export const resolveException = z.object({ status: z.enum(['resolved', 'waived']), note: z.string().trim().min(5).max(500) }).strict();
export const itemsQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), status: z.enum(['calculated', 'needs_review', 'excluded']).optional() });

export const createAdjustment = z.object({
  employeeId: uuid, payrollPeriodId: uuid, componentId: uuid, kind: z.enum(['earning', 'deduction']), amount: money.refine((s) => Number(s) > 0, 'must be positive'),
  reason: z.string().trim().min(5).max(300), source: z.enum(['manual', 'arrears', 'correction']).default('manual'),
}).strict();
export const reviewAdjustment = z.object({ comment: z.string().trim().max(300).optional() }).strict();

export type PayGroupView = { id: string; code: string; name: string; frequency: string; periodStartDay: number; attendanceSource: string; inputCutoffDay: number | null; payDay: number | null; status: string };
export type PeriodView = { id: string; payGroupId: string; periodCode: string; periodStart: string; periodEnd: string; attendanceLockedAt: string | null; status: string };
export type RunView = {
  id: string; payrollPeriodId: string; periodCode: string; revision: number; runKind: string; status: string; paymentStatus: string;
  engineVersion: string | null; totals: { gross: string; employeeDeductions: string; employerContributions: string; netPay: string } | null;
  employeeCount: number; openBlocking: number; openWarnings: number; correctionOfRunId: string | null; correctionReason: string | null; rejectionReason: string | null;
  createdBy: string | null; submittedBy: string | null; approvedBy: string | null; lockedBy: string | null;
  createdAt: string; submittedAt: string | null; approvedAt: string | null; lockedAt: string | null;
};
export type ExceptionView = {
  id: string; stage: string; severity: 'blocking' | 'warning'; code: string; message: string; employeeId: string | null; employeeName: string | null;
  status: 'open' | 'resolved' | 'waived'; resolutionNote: string | null; details: Record<string, unknown>;
};
export type RunItemView = {
  id: string; employeeId: string; employeeNumber: string; employeeName: string; workingDays: string; paidDays: string; unpaidDays: string;
  grossEarnings: string; employeeDeductions: string; employerContributions: string; netPay: string; status: string; warnings: unknown[];
};
export type LineView = {
  componentCode: string; label: string; type: string; method: string; amount: string; calculationBase: string | null; appliedRate: string | null; trace: unknown;
};
export type AdjustmentView = {
  id: string; employeeId: string; employeeName: string; payrollPeriodId: string; componentId: string; kind: 'earning' | 'deduction'; amount: string; reason: string;
  source: string; status: string; createdBy: string | null; approvedBy: string | null;
};
export type PayslipView = {
  id: string; employeeId: string; employeeName: string; periodCode: string; revision: number; status: string; workingDays: string; paidDays: string; unpaidDays: string;
  earnings: Array<{ code: string; label: string; amount: string }>; deductions: Array<{ code: string; label: string; amount: string }>;
  employerContributions: Array<{ code: string; label: string; amount: string }>;
  grossEarnings: string; totalDeductions: string; netPay: string; issuedAt: string | null;
};
