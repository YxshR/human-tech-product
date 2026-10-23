import { z } from 'zod';
import { money, uuid } from './common';

export const PAYROLL_STATUSES = [
  'draft', 'validated', 'calculated', 'under_review', 'rejected', 'approved', 'locked', 'payslips_generated', 'cancelled',
] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

/** Mirrors app.payroll_run_transition_allowed in the database; a test keeps them identical. */
export const PAYROLL_TRANSITIONS: ReadonlyArray<readonly [PayrollStatus, PayrollStatus]> = [
  ['draft', 'validated'], ['draft', 'cancelled'],
  ['validated', 'calculated'], ['validated', 'draft'], ['validated', 'cancelled'],
  ['calculated', 'under_review'], ['calculated', 'draft'], ['calculated', 'cancelled'],
  ['under_review', 'approved'], ['under_review', 'rejected'],
  ['rejected', 'draft'], ['rejected', 'cancelled'],
  ['approved', 'locked'], ['approved', 'rejected'],
  ['locked', 'payslips_generated'],
];

export const canTransition = (from: PayrollStatus, to: PayrollStatus): boolean =>
  from === to || PAYROLL_TRANSITIONS.some(([a, b]) => a === from && b === to);

export const createPayrollRun = z.object({ payrollPeriodId: uuid }).strict();
export const rejectPayrollRun = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
export const correctionRequest = z.object({ reason: z.string().trim().min(10).max(1000) }).strict();

export const payrollTotals = z.object({
  gross: money, employeeDeductions: money, employerContributions: money, netPay: money,
});
