import { describe, expect, test } from "bun:test";

import { computeBonus, isDearnessAllowance, type BonusMonth } from "@/services/bonus-calc";

const rules = { percentage: 8.33, eligibilityCeiling: 21_000, calculationCeiling: 7_000 };
const year = (wage: number, days = 26): BonusMonth[] =>
  Array.from({ length: 12 }, (_, i) => ({ month: String(i + 1), wage, days }));

describe("computeBonus", () => {
  test("each month counts at most the calculation ceiling", () => {
    const result = computeBonus(year(15_000), rules);
    expect(result.eligible).toBe(true);
    expect(result.bonusWages).toBe(84_000);
    expect(result.amount).toBe(Math.round(84_000 * 0.0833));
  });

  test("a month under the ceiling counts at what was earned", () => {
    const months = [...year(15_000).slice(0, 11), { month: "12", wage: 3_000, days: 10 }];
    expect(computeBonus(months, rules).bonusWages).toBe(77_000 + 3_000);
  });

  test("over 21,000 a month is not covered", () => {
    const result = computeBonus(year(25_000), rules);
    expect(result.eligible).toBe(false);
    expect(result.amount).toBe(0);
  });

  test("under 30 days worked is not eligible", () => {
    const result = computeBonus([{ month: "3", wage: 10_000, days: 29.5 }], rules);
    expect(result.eligible).toBe(false);
  });

  test("a leaver with a few months still gets a proportionate bonus", () => {
    const result = computeBonus(year(12_000).slice(0, 3), { ...rules, percentage: 20 });
    expect(result.amount).toBe(Math.round(21_000 * 0.2));
  });

  test("the minimum bonus is 100", () => {
    expect(computeBonus([{ month: "3", wage: 1_000, days: 30 }], rules).amount).toBe(100);
  });

  test("dearness allowance is recognized by name", () => {
    expect(isDearnessAllowance("Dearness Allowance")).toBe(true);
    expect(isDearnessAllowance("DA")).toBe(true);
    expect(isDearnessAllowance("D.A.")).toBe(true);
    expect(isDearnessAllowance("HRA")).toBe(false);
    expect(isDearnessAllowance("Data card")).toBe(false);
  });
});
