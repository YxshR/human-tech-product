import { describe, expect, it } from 'vitest';
import { countLeaveDays, eachDate, halfDaysToString, weekday } from '../src/leave/leave-days';

const base = { weeklyOffs: () => [0], holidays: new Set<string>(), countWeeklyOffs: false, countHolidays: false, partial: false };
describe('countLeaveDays', () => {
  it('2031-03-03 is a Monday', () => expect(weekday('2031-03-03')).toBe(1));
  it('excludes Sundays by default', () => {
    const r = countLeaveDays({ ...base, start: '2031-03-07', end: '2031-03-11' }); // Fri Sat Sun Mon Tue
    expect(r.countedDates).toEqual(['2031-03-07', '2031-03-08', '2031-03-10', '2031-03-11']);
    expect(halfDaysToString(r.halfDays)).toBe('4.00');
  });
  it('honours shift-specific weekly offs per date', () => {
    const r = countLeaveDays({ ...base, weeklyOffs: () => [0, 6], start: '2031-03-07', end: '2031-03-11' });
    expect(r.countedDates).toEqual(['2031-03-07', '2031-03-10', '2031-03-11']);
  });
  it('skips holidays unless the policy counts them', () => {
    const hol = new Set(['2031-03-10']);
    expect(countLeaveDays({ ...base, holidays: hol, start: '2031-03-10', end: '2031-03-11' }).countedDates).toEqual(['2031-03-11']);
    expect(countLeaveDays({ ...base, holidays: hol, countHolidays: true, start: '2031-03-10', end: '2031-03-11' }).countedDates).toHaveLength(2);
  });
  it('counts weekly offs when the policy says so', () => {
    expect(countLeaveDays({ ...base, countWeeklyOffs: true, start: '2031-03-08', end: '2031-03-09' }).countedDates).toHaveLength(2);
  });
  it('a half day is 0.5 and zero on a weekly off', () => {
    expect(halfDaysToString(countLeaveDays({ ...base, partial: true, start: '2031-03-03', end: '2031-03-03' }).halfDays)).toBe('0.50');
    expect(countLeaveDays({ ...base, partial: true, start: '2031-03-09', end: '2031-03-09' }).halfDays).toBe(0);
  });
  it('rejects absurd spans', () => {
    expect(() => countLeaveDays({ ...base, start: '2031-01-01', end: '2033-01-01' })).toThrow(RangeError);
  });
  it('eachDate crosses month and leap-year boundaries', () => {
    expect(eachDate('2032-02-28', '2032-03-01')).toEqual(['2032-02-28', '2032-02-29', '2032-03-01']);
  });
});
