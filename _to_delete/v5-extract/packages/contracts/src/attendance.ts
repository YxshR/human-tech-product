import { z } from 'zod';
import { isoDate, uuid } from './common';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');
const instant = z.string().datetime({ offset: true });
const shiftCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'letters, digits, - or _');
const weekdays = z.array(z.number().int().min(0).max(6)).max(7).refine((a) => new Set(a).size === a.length, 'duplicate weekday');

export const createShift = z.object({
  code: shiftCode, name: z.string().trim().min(2).max(80), startTime: hhmm, endTime: hhmm,
  graceMinutes: z.number().int().min(0).max(240).default(0),
  halfDayMinutes: z.number().int().min(1).max(1440).default(240), fullDayMinutes: z.number().int().min(1).max(1440).default(480),
  weeklyOffDays: weekdays.default([0]),
}).strict().refine((v) => v.halfDayMinutes <= v.fullDayMinutes, { path: ['halfDayMinutes'], message: 'must not exceed fullDayMinutes' });
export const updateShift = z.object({
  name: z.string().trim().min(2).max(80).optional(), graceMinutes: z.number().int().min(0).max(240).optional(),
  halfDayMinutes: z.number().int().min(1).max(1440).optional(), fullDayMinutes: z.number().int().min(1).max(1440).optional(),
  weeklyOffDays: weekdays.optional(), status: z.enum(['active', 'inactive', 'archived']).optional(),
}).strict();
export const assignShift = z.object({ employeeId: uuid, shiftId: uuid, effectiveFrom: isoDate, effectiveTo: isoDate.nullish() }).strict()
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { path: ['effectiveTo'], message: 'must not be before effectiveFrom' });

export const createAttendancePolicy = z.object({
  name: z.string().trim().min(2).max(80), effectiveFrom: isoDate, effectiveTo: isoDate.nullish(),
  lateAfterGraceCountsAsLate: z.boolean().default(true), lateMarksPerHalfDay: z.number().int().min(1).max(31).nullish(),
  missingPunchPolicy: z.enum(['flag', 'half_day', 'absent']).default('flag'), allowEmployeeCheckin: z.boolean().default(false),
  correctionWindowDays: z.number().int().min(0).max(90).default(7), overtimeEnabled: z.boolean().default(false),
}).strict().refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { path: ['effectiveTo'], message: 'must not be before effectiveFrom' });

export const MARKABLE_STATUSES = ['present', 'absent', 'half_day', 'work_from_home', 'weekly_off', 'holiday', 'not_marked'] as const;
export const markAttendance = z.object({
  employeeId: uuid, workDate: isoDate, status: z.enum(MARKABLE_STATUSES).optional(),
  checkInAt: instant.nullish(), checkOutAt: instant.nullish(), reason: z.string().trim().min(3).max(300),
}).strict().refine((v) => v.status !== undefined || v.checkInAt || v.checkOutAt, { path: ['status'], message: 'provide a status or punch times' })
  .refine((v) => !v.checkInAt || !v.checkOutAt || Date.parse(v.checkOutAt) >= Date.parse(v.checkInAt), { path: ['checkOutAt'], message: 'must not be before checkInAt' });

export const importEvents = z.object({
  events: z.array(z.object({
    employeeId: uuid, type: z.enum(['check_in', 'check_out']), occurredAt: instant,
    deviceReference: z.string().trim().max(100).optional(), idempotencyKey: z.string().trim().min(8).max(120),
  }).strict()).min(1).max(500),
}).strict();

export const requestCorrection = z.object({
  employeeId: uuid.optional(), workDate: isoDate,
  requested: z.object({ status: z.enum(MARKABLE_STATUSES).optional(), checkInAt: instant.nullish(), checkOutAt: instant.nullish() }).strict()
    .refine((v) => v.status !== undefined || v.checkInAt || v.checkOutAt, 'nothing requested'),
  reason: z.string().trim().min(3).max(300),
}).strict();
export const reviewCorrection = z.object({ comment: z.string().trim().max(300).optional() }).strict();
export const finalizeDay = z.object({ date: isoDate }).strict();
export const lockAttendance = z.object({ periodId: uuid }).strict();

export const attendanceDaysQuery = z.object({
  from: isoDate, to: isoDate, employeeId: uuid.optional(),
  status: z.enum(['present', 'absent', 'half_day', 'leave', 'holiday', 'weekly_off', 'work_from_home', 'not_marked']).optional(),
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
}).refine((v) => v.to >= v.from, { path: ['to'], message: 'must not be before from' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 92, { path: ['to'], message: 'window may be at most 92 days' });
export const summaryQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), employeeId: uuid.optional() });

export type ShiftView = {
  id: string; code: string; name: string; startTime: string; endTime: string; crossesMidnight: boolean; graceMinutes: number;
  halfDayMinutes: number; fullDayMinutes: number; weeklyOffDays: number[]; status: string;
};
export type AttendancePolicyView = {
  id: string; name: string; version: number; effectiveFrom: string; effectiveTo: string | null; lateAfterGraceCountsAsLate: boolean;
  lateMarksPerHalfDay: number | null; missingPunchPolicy: 'flag' | 'half_day' | 'absent'; allowEmployeeCheckin: boolean;
  correctionWindowDays: number; overtimeEnabled: boolean; status: 'draft' | 'active' | 'retired';
};
export type AttendanceDayView = {
  id: string; employeeId: string; employeeNumber: string; employeeName: string; workDate: string; status: string;
  checkInAt: string | null; checkOutAt: string | null; workedMinutes: number | null; lateMinutes: number; overtimeMinutes: number;
  paidDayFraction: string; source: string; approvalStatus: 'pending' | 'approved' | 'rejected'; correctionVersion: number;
};
export type CorrectionView = {
  id: string; attendanceDayId: string; employeeId: string; employeeName: string; workDate: string;
  previous: Record<string, unknown>; requested: Record<string, unknown>; reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'; requestedBy: string | null; reviewedBy: string | null; reviewComment: string | null; createdAt: string;
};
export type AttendanceSummaryView = {
  employeeId: string; month: string; presentDays: number; halfDays: number; absentDays: number; leaveDays: number; holidays: number; weeklyOffs: number;
  workFromHomeDays: number; notMarked: number; lateDays: number; lateMarkDeductionDays: number; overtimeMinutes: number; paidDays: string; unpaidDays: string;
};
