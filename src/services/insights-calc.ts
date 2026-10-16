/**
 * Pure calculations behind HR insights. Dates are YYYY-MM-DD strings; months are YYYY-MM.
 */

export type InsightMember = {
  hireDate: string | null;
  /** The last day they were with the organization (exit last working day, or deactivation); null if still here. */
  leftOn: string | null;
  /** Resignation counts as voluntary; termination, retirement and deactivation without an exit do not. */
  voluntary: boolean;
};

const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};

/** The last n months ending with the month of the given date, oldest first. */
export const lastMonths = (today: string, n: number) => {
  const [y, m] = today.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y!, m! - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
};

/** Someone without a hire date counts as having always been here. */
const onRollOn = (member: InsightMember, date: string) =>
  (!member.hireDate || member.hireDate <= date) && (!member.leftOn || member.leftOn >= date);

/** Headcount at each month end (or today, for the current month), with joiners and leavers in the month. */
export const headcountTrend = (members: InsightMember[], months: string[], today: string) =>
  months.map((month) => {
    const end = monthEnd(month) < today ? monthEnd(month) : today;
    return {
      month,
      headcount: members.filter((member) => onRollOn(member, end)).length,
      joined: members.filter((member) => member.hireDate?.slice(0, 7) === month).length,
      left: members.filter((member) => member.leftOn?.slice(0, 7) === month && member.leftOn <= today).length,
    };
  });

/**
 * Attrition over the months given: leavers divided by the average headcount, as a percentage.
 * Over twelve months this is the annual attrition rate.
 */
export const attrition = (members: InsightMember[], trend: ReturnType<typeof headcountTrend>, today: string) => {
  const first = trend[0]?.month;
  const leavers = members.filter((member) => member.leftOn && first && member.leftOn.slice(0, 7) >= first && member.leftOn <= today);
  const average = trend.length ? trend.reduce((sum, row) => sum + row.headcount, 0) / trend.length : 0;
  return {
    leavers: leavers.length,
    voluntary: leavers.filter((member) => member.voluntary).length,
    averageHeadcount: Math.round(average * 10) / 10,
    ratePercent: average > 0 ? Math.round((leavers.length / average) * 1000) / 10 : 0,
  };
};

const yearsBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / (365.25 * 86_400_000);

export const TENURE_BANDS = ["Under 1 year", "1–3 years", "3–5 years", "5+ years", "Unknown"] as const;

export const tenureBand = (hireDate: string | null, today: string): (typeof TENURE_BANDS)[number] => {
  if (!hireDate) return "Unknown";
  const years = yearsBetween(hireDate, today);
  return years < 1 ? "Under 1 year" : years < 3 ? "1–3 years" : years < 5 ? "3–5 years" : "5+ years";
};

export const averageTenureYears = (hireDates: (string | null)[], today: string) => {
  const known = hireDates.filter((date): date is string => !!date && date <= today);
  return known.length ? Math.round((known.reduce((sum, date) => sum + yearsBetween(date, today), 0) / known.length) * 10) / 10 : null;
};

/** Counts by label, largest first. */
export const breakdown = (labels: (string | null | undefined)[], unknown = "Not set") => {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label || unknown, (counts.get(label || unknown) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

export type DayRow = { employeeId: string; date: string; status: string; lateMinutes: number; workedMinutes: number | null; expectedMinutes: number | null };

/** Attendance rate counts present days and half a day for half days, out of days not on leave. */
export const attendanceSummary = (rows: DayRow[]) => {
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  const present = count("present");
  const half = count("half_day");
  const absent = count("absent");
  const incomplete = count("incomplete");
  const onLeave = count("on_leave");
  const workdays = rows.length - onLeave;
  const late = rows.filter((row) => row.lateMinutes > 0);
  const overtimeMinutes = rows.reduce(
    (sum, row) => sum + (row.workedMinutes !== null && row.expectedMinutes !== null ? Math.max(0, row.workedMinutes - row.expectedMinutes) : 0),
    0,
  );
  return {
    attendanceRatePercent: workdays > 0 ? Math.round(((present + half * 0.5) / workdays) * 1000) / 10 : null,
    present,
    halfDays: half,
    absent,
    incomplete,
    onLeave,
    lateArrivals: late.length,
    averageLateMinutes: late.length ? Math.round(late.reduce((sum, row) => sum + row.lateMinutes, 0) / late.length) : 0,
    overtimeHours: Math.round(overtimeMinutes / 6) / 10,
  };
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Absences and late arrivals by weekday: a Monday or Friday pattern shows up here. */
export const byWeekday = (rows: DayRow[]) =>
  WEEKDAYS.map((day, index) => {
    const ofDay = rows.filter((row) => new Date(`${row.date}T00:00:00Z`).getUTCDay() === index);
    return { day, absent: ofDay.filter((row) => row.status === "absent").length, late: ofDay.filter((row) => row.lateMinutes > 0).length, days: ofDay.length };
  }).filter((row) => row.days > 0);

/** Days of this year's anniversary of a date, from today, within the next n days; null otherwise. */
export const daysUntilAnniversary = (date: string, today: string, within: number) => {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    // 29 February is celebrated on 28 February outside leap years.
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const candidate = date.slice(5) === "02-29" && !leap ? `${y}-02-28` : `${y}${date.slice(4)}`;
    const days = Math.round((Date.parse(`${candidate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    if (days >= 0) return days <= within ? days : null;
  }
  return null;
};
