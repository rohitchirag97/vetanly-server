/**
 * Which work day a punch belongs to. A punch counts toward the shift it is nearest to, so
 * checking out after midnight (a night shift, or a day shift that ran late) stays on the
 * day the work started and is paid there. Time before a shift starts counts double: people
 * arrive a little early, but they can stay very late.
 */

export type ShiftTimes = { startTime: string; endTime: string };

const DAY = 1440;
// Assumed working hours for days without a rostered shift.
const DEFAULT_SHIFT: ShiftTimes = { startTime: "09:00", endTime: "18:00" };
const EARLY_WEIGHT = 2;

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

/** The shift as [start, end] minutes from the start of its own day; overnight ends run past 1440. */
const window = (shift: ShiftTimes | null) => {
  const { startTime, endTime } = shift ?? DEFAULT_SHIFT;
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  return { start, end: end > start ? end : end + DAY };
};

export const previousDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - DAY * 60_000).toISOString().slice(0, 10);

/**
 * @param localDate calendar date of the punch in the organization's time zone
 * @param minuteOfDay minutes since local midnight of the punch
 * @param todayShift shift rostered on `localDate`, or null
 * @param yesterdayShift shift rostered on the day before, or null
 */
export const workDateOf = (
  localDate: string,
  minuteOfDay: number,
  todayShift: ShiftTimes | null,
  yesterdayShift: ShiftTimes | null,
): string => {
  const today = window(todayShift);
  const yesterday = window(yesterdayShift);
  // Yesterday's shift, measured on today's clock, ends at end - DAY (negative unless it ran past midnight).
  const pastYesterday = Math.max(0, minuteOfDay - (yesterday.end - DAY));
  const beforeToday = minuteOfDay < today.start ? (today.start - minuteOfDay) * EARLY_WEIGHT : 0;
  const afterToday = minuteOfDay > today.end ? minuteOfDay - today.end : 0;
  return pastYesterday < beforeToday + afterToday ? previousDate(localDate) : localDate;
};
