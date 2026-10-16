import { describe, expect, test } from "bun:test";

import { calculatePayroll, type CalcInput, workedAfterBreak } from "@/services/payroll-calc";

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
    offDayWorkPolicy: "manager",
    weeklyOffWorkMultiplier: 1,
    holidayWorkMultiplier: 2,
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
  overtimeMinutes: 0,
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

describe("calculatePayroll with a bonus", () => {
  const statutory = {
    settings: {
      pfEnabled: true, pfWageCeiling: 15_000, pfCapWages: true,
      esiEnabled: true, esiWageCeiling: 21_000,
      ptEnabled: false, ptState: null, ptFlatAmount: null,
      tdsEnabled: true,
    },
    employee: { pfApplicable: true, esiApplicable: true, gender: null, taxRegime: "old" as const, declaredDeductions: 0 },
    ytd: { gross: 0, tds: 0, professionalTax: 0 },
  };
  // A month, salary 60,000, all days present; old regime so some tax is due.
  const month: CalcInput = {
    ...base,
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    compensationAmount: 60_000,
    settings: { ...base.settings, weeklyOffDays: [] },
    days: Array.from({ length: 31 }, (_, i) => present(`2026-10-${String(i + 1).padStart(2, "0")}`)),
    statutory,
  };

  test("a bonus raises gross and net but not PF or ESI", () => {
    const plain = calculatePayroll(month);
    const withBonus = calculatePayroll({ ...month, bonusCents: 5_000_000 });
    expect(withBonus.bonusPayCents).toBe(5_000_000);
    expect(withBonus.grossPayCents).toBe(plain.grossPayCents + 5_000_000);
    expect(withBonus.statutory?.pfEmployee).toBe(plain.statutory?.pfEmployee);
    expect(withBonus.statutory?.esiEmployee).toBe(plain.statutory?.esiEmployee);
  });

  test("the tax on a bonus is deducted in full that month, not spread over the year", async () => {
    const { computeMonthlyTds, annualTax } = await import("@/services/statutory-calc");
    const ytd = { gross: 600_000, tds: 40_000, professionalTax: 0 };
    const plainTds = computeMonthlyTds(100_000, "2026-10-31", 0, statutory.settings, statutory.employee, ytd);
    const bonusTds = computeMonthlyTds(100_000, "2026-10-31", 0, statutory.settings, statutory.employee, ytd, 50_000);
    // April-September already earned 6 lakh; October to March projects 6 more months of 1 lakh.
    const extra = annualTax(1_200_000 + 50_000, "old", 0, 0).total - annualTax(1_200_000, "old", 0, 0).total;
    expect(bonusTds).toBe(Math.round(plainTds + extra));
    expect(bonusTds).toBeGreaterThan(plainTds);
  });
});

describe("workedAfterBreak", () => {
  test("a full shift loses the whole break", () => {
    expect(workedAfterBreak(480, 480, 60)).toBe(420);
  });

  test("a short visit loses only its share of the break", () => {
    // 2:44 to 3:48 on a 9-to-5 shift with a one-hour break.
    expect(workedAfterBreak(64, 480, 60)).toBe(56);
  });

  test("overtime never loses more than the break", () => {
    expect(workedAfterBreak(600, 480, 60)).toBe(540);
  });

  test("no break, nothing deducted", () => {
    expect(workedAfterBreak(64, 480, 0)).toBe(64);
  });
});

// The test week runs Monday 2 to Sunday 8 November 2026 with Sunday as the weekly off.
describe("calculatePayroll with work on off days", () => {
  const sunday = "2026-11-08";
  const worked = (date: string, workedMinutes = 480, status: "present" | "half_day" = "present") => ({ ...present(date), workedMinutes, status });
  const perDay = 7_000 / 6;

  test("by default a worked off-day waits for a manager and is not paid yet", () => {
    const result = calculatePayroll({ ...base, days: [worked(sunday)] });
    expect(result.offDayPayCents).toBe(0);
    expect(result.offDayPending).toEqual([{ date: sunday, days: 1 }]);
  });

  test("a 'pay' decision pays one extra day; comp-off and 'none' pay nothing and are settled", () => {
    const paid = calculatePayroll({ ...base, days: [worked(sunday)], offDayOutcomes: new Map([[sunday, "pay"]]) });
    expect(paid.offDayPayCents).toBe(Math.round(perDay * 100));
    expect(paid.grossPayCents).toBe(paid.basePayCents + paid.offDayPayCents);
    for (const outcome of ["comp_off", "none"] as const) {
      const result = calculatePayroll({ ...base, days: [worked(sunday)], offDayOutcomes: new Map([[sunday, outcome]]) });
      expect(result.offDayPayCents).toBe(0);
      expect(result.offDayPending).toEqual([]);
    }
  });

  test("an 'always pay' policy pays without a decision, half a day for a half day", () => {
    const settings = { ...base.settings, offDayWorkPolicy: "pay" as const };
    const result = calculatePayroll({ ...base, settings, days: [worked(sunday, 240, "half_day")] });
    expect(result.offDayDays).toBe(0.5);
    expect(result.offDayPayCents).toBe(Math.round((perDay / 2) * 100));
  });

  test("double wages on a paid holiday add one day on top of the holiday pay", () => {
    const settings = { ...base.settings, offDayWorkPolicy: "pay" as const, paidHolidays: true };
    const result = calculatePayroll({ ...base, settings, holidays: ["2026-11-04"], days: [worked("2026-11-04")] });
    expect(result.offDayPayCents).toBe(Math.round(perDay * 100));
  });

  test("hourly staff are paid for the hours they worked on the off day", () => {
    const result = calculatePayroll({
      ...base,
      compensationType: "hourly",
      compensationAmount: 100,
      days: [worked(sunday, 300)],
      offDayOutcomes: new Map([[sunday, "pay"]]),
    });
    expect(result.offDayPayCents).toBe(500_00);
  });
});
