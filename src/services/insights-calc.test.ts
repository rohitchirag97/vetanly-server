import { describe, expect, test } from "bun:test";

import {
  attendanceSummary,
  attrition,
  breakdown,
  byWeekday,
  daysUntilAnniversary,
  headcountTrend,
  lastMonths,
  tenureBand,
} from "@/services/insights-calc";

const today = "2026-10-14";

describe("workforce", () => {
  const members = [
    { hireDate: "2024-01-10", leftOn: null, voluntary: false },
    { hireDate: "2026-08-05", leftOn: null, voluntary: false },
    { hireDate: "2025-03-01", leftOn: "2026-09-15", voluntary: true },
    { hireDate: null, leftOn: "2026-10-31", voluntary: false }, // serving notice, still here today
    { hireDate: "2026-11-01", leftOn: null, voluntary: false }, // joins later
  ];
  const months = lastMonths(today, 3);

  test("last months, oldest first", () => {
    expect(months).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(lastMonths("2026-01-31", 2)).toEqual(["2025-12", "2026-01"]);
  });

  test("headcount at each month end, joiners and leavers", () => {
    const trend = headcountTrend(members, months, today);
    expect(trend).toEqual([
      { month: "2026-08", headcount: 4, joined: 1, left: 0 },
      { month: "2026-09", headcount: 3, joined: 0, left: 1 },
      // The October leaver is still on the roll today and not counted as left yet.
      { month: "2026-10", headcount: 3, joined: 0, left: 0 },
    ]);
  });

  test("attrition: leavers over average headcount", () => {
    const trend = headcountTrend(members, months, today);
    expect(attrition(members, trend, today)).toEqual({ leavers: 1, voluntary: 1, averageHeadcount: 3.3, ratePercent: 30 });
  });

  test("tenure bands", () => {
    expect(tenureBand("2026-01-01", today)).toBe("Under 1 year");
    expect(tenureBand("2023-01-01", today)).toBe("3–5 years");
    expect(tenureBand(null, today)).toBe("Unknown");
  });

  test("breakdown sorts by count and names blanks", () => {
    expect(breakdown(["Sales", null, "Sales", "Ops"])).toEqual([
      { name: "Sales", count: 2 },
      { name: "Not set", count: 1 },
      { name: "Ops", count: 1 },
    ]);
  });
});

describe("attendance", () => {
  const row = (date: string, status: string, lateMinutes = 0, workedMinutes: number | null = 480) => ({
    employeeId: "e",
    date,
    status,
    lateMinutes,
    workedMinutes,
    expectedMinutes: 480,
  });
  const rows = [
    row("2026-10-05", "present", 15, 540), // Monday, late, 1 h overtime
    row("2026-10-06", "half_day", 0, 240),
    row("2026-10-07", "absent", 0, null),
    row("2026-10-08", "on_leave", 0, null),
    row("2026-10-12", "absent", 0, null), // Monday
  ];

  test("rate excludes leave and counts half days as half", () => {
    const summary = attendanceSummary(rows);
    expect(summary.attendanceRatePercent).toBe(37.5);
    expect(summary.lateArrivals).toBe(1);
    expect(summary.averageLateMinutes).toBe(15);
    expect(summary.overtimeHours).toBe(1);
  });

  test("weekday pattern", () => {
    const monday = byWeekday(rows).find((d) => d.day === "Mon");
    expect(monday).toEqual({ day: "Mon", absent: 1, late: 1, days: 2 });
  });
});

describe("anniversaries", () => {
  test("within the window, this year or next", () => {
    expect(daysUntilAnniversary("1990-10-20", today, 30)).toBe(6);
    expect(daysUntilAnniversary("1990-10-14", today, 30)).toBe(0);
    expect(daysUntilAnniversary("1990-10-13", today, 30)).toBeNull();
    expect(daysUntilAnniversary("1990-01-05", "2026-12-20", 30)).toBe(16);
  });

  test("29 February falls on 28 February outside leap years", () => {
    expect(daysUntilAnniversary("2000-02-29", "2027-02-20", 30)).toBe(8);
    expect(daysUntilAnniversary("2000-02-29", "2028-02-20", 30)).toBe(9);
  });
});
