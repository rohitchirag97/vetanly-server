import { describe, expect, test } from "bun:test";

import { calculatePayroll, type CalcInput } from "@/services/payroll-calc";

// A week from Monday 2 Nov to Sunday 8 Nov 2026, Sunday the company weekly off.
const base: CalcInput = {
  periodStart: "2026-11-02",
  periodEnd: "2026-11-08",
  hireDate: null,
  compensationType: "fixed_salary",
  compensationAmount: 7_000,
  components: [],
  shiftExpectedMinutes: 480,
  settings: {
    overtimeCalculationMethod: "hourly_rate_multiplier",
    overtimeFixedAmountPerHour: null,
    overtimeHourlyRateMultiplier: 1.5,
    overtimeHoursPerWorkday: null,
    lateFineMethod: "none",
    lateFineAmount: null,
    lateFineCapPerPayPeriod: null,
    weeklyOffDays: [0],
    autoDeductLoans: false,
    paidHolidays: false,
    overtimeApprovalRequired: false,
  },
  days: [],
  holidays: [],
  leaves: [],
  loans: [],
};

const present = (date: string) => ({
  employeeId: "e",
  employeeName: "E",
  date,
  firstCheckIn: null,
  lastCheckOut: null,
  workedMinutes: 480,
  expectedMinutes: 480,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  status: "present" as const,
});

describe("calculatePayroll with a shift roster", () => {
  test("without a roster, the company weekly off is skipped", () => {
    expect(calculatePayroll(base).workingDays).toBe(6);
  });

  test("a rostered Sunday counts as a working day and a rostered day off does not", () => {
    const rosterDays = new Map<string, "work" | "off">([
      ["2026-11-08", "work"],
      ["2026-11-03", "off"],
    ]);
    const result = calculatePayroll({
      ...base,
      rosterDays,
      days: ["2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map(present),
    });
    expect(result.workingDays).toBe(6);
    expect(result.presentDays).toBe(6);
    expect(result.absentDays).toBe(0);
    // Full pay: every working day was worked, and the rostered day off is not an absence.
    expect(result.basePayCents).toBe(700_000);
  });
});
