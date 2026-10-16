import { describe, expect, test } from "bun:test";

import { defaultDailyRate, gratuity, noticeShortfallDays, serviceLength, settlementTotals } from "@/services/settlement-calc";

describe("serviceLength", () => {
  test("counts whole years and leftover months up to the last working day", () => {
    expect(serviceLength("2020-04-01", "2026-03-31")).toMatchObject({ years: 6, months: 0 });
    expect(serviceLength("2021-01-15", "2026-08-14")).toMatchObject({ years: 5, months: 7 });
  });
});

describe("gratuity", () => {
  test("15/26 of monthly basic per year, a part-year over six months rounding up", () => {
    // 5 years 7 months -> 6 years; 30,000 x 15/26 x 6 = 1,03,846.
    expect(gratuity({ hireDate: "2021-01-15", lastWorkingDay: "2026-08-14", monthlyBasic: 30_000 })).toMatchObject({ eligible: true, years: 6, amount: 103_846 });
  });

  test("needs five years, with four years and 240 days counting", () => {
    expect(gratuity({ hireDate: "2022-06-01", lastWorkingDay: "2026-05-31", monthlyBasic: 30_000 }).eligible).toBe(false);
    // 4 years 8 months: past 4 years 240 days, and rounds up to 5 years.
    expect(gratuity({ hireDate: "2021-01-01", lastWorkingDay: "2025-08-31", monthlyBasic: 26_000 })).toMatchObject({ eligible: true, years: 5, amount: 75_000 });
  });

  test("is capped at 20 lakh", () => {
    expect(gratuity({ hireDate: "1990-01-01", lastWorkingDay: "2026-01-01", monthlyBasic: 500_000 }).amount).toBe(2_000_000);
  });
});

describe("noticeShortfallDays", () => {
  test("counts notice days not served", () => {
    expect(noticeShortfallDays({ resignationDate: "2026-10-01", noticeDays: 30, lastWorkingDay: "2026-10-21" })).toBe(10);
    expect(noticeShortfallDays({ resignationDate: "2026-10-01", noticeDays: 30, lastWorkingDay: "2026-11-05" })).toBe(0);
  });
});

describe("defaultDailyRate and totals", () => {
  test("daily rate by pay type", () => {
    expect(defaultDailyRate({ compensationType: "fixed_salary", compensationAmount: 26_000 })).toBe(1_000);
    expect(defaultDailyRate({ compensationType: "daily", compensationAmount: 800 })).toBe(800);
    expect(defaultDailyRate({ compensationType: "hourly", compensationAmount: 150, hoursPerDay: 9 })).toBe(1_350);
  });

  test("net is earnings less deductions, and can be negative", () => {
    expect(settlementTotals([
      { kind: "salary", label: "Salary", amount: "12000.50" },
      { kind: "leave_encashment", label: "Leave", amount: "5000" },
      { kind: "loan_recovery", label: "Loan", amount: "20000" },
    ])).toEqual({ totalEarnings: "17000.50", totalDeductions: "20000.00", netPayable: "-2999.50" });
  });
});
