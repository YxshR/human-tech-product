import { describe, expect, it } from 'vitest';
import { deriveDay, fractionFor, lateDeductionDays } from '../src/attendance/derive';

const at = (hhmm: string) => new Date(`2031-03-03T${hhmm}:00Z`);
const shift = { start: at('09:00'), graceMinutes: 10, halfDayMinutes: 240, fullDayMinutes: 480 };
const pol = { missingPunchPolicy: 'flag' as const, lateCounts: true, overtimeEnabled: true };

describe('deriveDay', () => {
  it('full day, on time', () => expect(deriveDay(shift, pol, at('09:05'), at('17:30'), true)).toMatchObject({ status: 'present', workedMinutes: 505, lateMinutes: 0, overtimeMinutes: 25, paidFraction: 1 }));
  it('late beyond grace records minutes from shift start', () => expect(deriveDay(shift, pol, at('09:25'), at('18:00'), true).lateMinutes).toBe(25));
  it('exactly at grace is not late', () => expect(deriveDay(shift, pol, at('09:10'), at('18:00'), true).lateMinutes).toBe(0));
  it('late ignored when the policy does not count it', () => expect(deriveDay(shift, { ...pol, lateCounts: false }, at('10:00'), at('18:00'), true).lateMinutes).toBe(0));
  it('half day between thresholds', () => expect(deriveDay(shift, pol, at('09:00'), at('13:30'), true)).toMatchObject({ status: 'half_day', paidFraction: 0.5 }));
  it('too short is absent', () => expect(deriveDay(shift, pol, at('09:00'), at('10:00'), true)).toMatchObject({ status: 'absent', paidFraction: 0 }));
  it('no overtime unless enabled', () => expect(deriveDay(shift, { ...pol, overtimeEnabled: false }, at('09:00'), at('20:00'), true).overtimeMinutes).toBe(0));
  it('no punches => not_marked', () => expect(deriveDay(shift, pol, null, null, true).status).toBe('not_marked'));
  it('open day is present-so-far, not flagged', () => expect(deriveDay(shift, pol, at('09:00'), null, false)).toMatchObject({ status: 'present', needsReview: false }));
  it.each([['flag', 'present', 1, true], ['half_day', 'half_day', 0.5, false], ['absent', 'absent', 0, false]] as const)(
    'closed day with a missing punch under %s', (p, status, frac, review) => {
      expect(deriveDay(shift, { ...pol, missingPunchPolicy: p }, at('09:00'), null, true)).toMatchObject({ status, paidFraction: frac, needsReview: review });
    });
  it('works without a shift or policy (default thresholds, never late)', () => {
    expect(deriveDay(null, null, at('09:00'), at('17:00'), true)).toMatchObject({ status: 'present', lateMinutes: 0 });
    expect(deriveDay(null, null, at('09:00'), at('13:00'), true).status).toBe('half_day');
  });
  it('check-out before check-in never yields negative minutes', () => expect(deriveDay(shift, pol, at('10:00'), at('09:00'), true).workedMinutes).toBe(0));
});
describe('helpers', () => {
  it('fractionFor', () => { expect(fractionFor('holiday')).toBe(1); expect(fractionFor('half_day')).toBe(0.5); expect(fractionFor('absent')).toBe(0); expect(fractionFor('leave')).toBe(0); });
  it('lateDeductionDays', () => { expect(lateDeductionDays(7, 3)).toBe(1); expect(lateDeductionDays(2, 3)).toBe(0); expect(lateDeductionDays(9, null)).toBe(0); });
});
