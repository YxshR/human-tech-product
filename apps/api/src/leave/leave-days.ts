/** Pure day-counting for leave requests (kept free of I/O so it is trivially testable). */
export interface DayCountInput {
  start: string; end: string; partial: boolean;
  weeklyOffs: (date: string) => number[];       // weekly off weekdays that apply on that date
  holidays: ReadonlySet<string>;                 // non-optional holiday dates that apply to the employee
  countWeeklyOffs: boolean; countHolidays: boolean;
}
export interface DayCount { halfDays: number; countedDates: string[] }

const MAX_SPAN_DAYS = 366;

export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const e = Date.parse(`${end}T00:00:00Z`);
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= e; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
export const weekday = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();

export function countLeaveDays(i: DayCountInput): DayCount {
  const dates = eachDate(i.start, i.end);
  if (dates.length > MAX_SPAN_DAYS) throw new RangeError(`leave cannot span more than ${MAX_SPAN_DAYS} days`);
  const counted = dates.filter((d) => {
    if (!i.countWeeklyOffs && i.weeklyOffs(d).includes(weekday(d))) return false;
    if (!i.countHolidays && i.holidays.has(d)) return false;
    return true;
  });
  // A half day is a single counted date worth one half-day unit; a full date is two.
  return { halfDays: i.partial ? counted.length : counted.length * 2, countedDates: counted };
}
export const halfDaysToString = (h: number): string => (h / 2).toFixed(2);
