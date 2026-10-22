/** Pure derivation of a day record from punches, shift and policy (no I/O, fully unit-tested). */
export interface ShiftTimes { start: Date; graceMinutes: number; halfDayMinutes: number; fullDayMinutes: number }
export interface DerivePolicy { missingPunchPolicy: 'flag' | 'half_day' | 'absent'; lateCounts: boolean; overtimeEnabled: boolean }
export interface DerivedDay {
  status: 'present' | 'half_day' | 'absent' | 'not_marked';
  workedMinutes: number | null; lateMinutes: number; overtimeMinutes: number; paidFraction: number;
  /** A human must look at it (e.g. missing punch under the "flag" policy). */
  needsReview: boolean;
}

export const DEFAULT_THRESHOLDS = { halfDayMinutes: 240, fullDayMinutes: 480 };
const minutes = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 60_000);
const FRACTION = { present: 1, half_day: 0.5, absent: 0, not_marked: 0 } as const;

/**
 * `dayClosed` is false while the day is still in progress: a check-in without a check-out is then simply
 * "present so far", and the missing-punch policy is only applied once the day is finalised.
 */
export function deriveDay(shift: ShiftTimes | null, policy: DerivePolicy | null, checkIn: Date | null, checkOut: Date | null, dayClosed: boolean): DerivedDay {
  const half = shift?.halfDayMinutes ?? DEFAULT_THRESHOLDS.halfDayMinutes;
  const full = shift?.fullDayMinutes ?? DEFAULT_THRESHOLDS.fullDayMinutes;
  if (!checkIn && !checkOut) return { status: 'not_marked', workedMinutes: null, lateMinutes: 0, overtimeMinutes: 0, paidFraction: 0, needsReview: false };

  let late = 0;
  if (shift && checkIn && (policy?.lateCounts ?? true)) {
    const lateBy = minutes(shift.start, checkIn);
    late = lateBy > shift.graceMinutes ? lateBy : 0;
  }

  if (!checkIn || !checkOut) {
    if (!dayClosed && checkIn) return { status: 'present', workedMinutes: null, lateMinutes: late, overtimeMinutes: 0, paidFraction: 1, needsReview: false };
    const p = policy?.missingPunchPolicy ?? 'flag';
    if (p === 'absent') return { status: 'absent', workedMinutes: null, lateMinutes: late, overtimeMinutes: 0, paidFraction: 0, needsReview: false };
    if (p === 'half_day') return { status: 'half_day', workedMinutes: null, lateMinutes: late, overtimeMinutes: 0, paidFraction: 0.5, needsReview: false };
    return { status: 'present', workedMinutes: null, lateMinutes: late, overtimeMinutes: 0, paidFraction: 1, needsReview: true };
  }

  const worked = Math.max(0, minutes(checkIn, checkOut));
  const status = worked >= full ? 'present' : worked >= half ? 'half_day' : 'absent';
  const overtime = policy?.overtimeEnabled && worked > full ? worked - full : 0;
  return { status, workedMinutes: worked, lateMinutes: late, overtimeMinutes: overtime, paidFraction: FRACTION[status], needsReview: false };
}

export const fractionFor = (status: string): number =>
  status === 'present' || status === 'work_from_home' || status === 'weekly_off' || status === 'holiday' ? 1 : status === 'half_day' ? 0.5 : 0;

/** Late-mark deduction: every N late days costs half a day of pay. */
export function lateDeductionDays(lateDays: number, marksPerHalfDay: number | null | undefined): number {
  return marksPerHalfDay && marksPerHalfDay > 0 ? Math.floor(lateDays / marksPerHalfDay) * 0.5 : 0;
}
