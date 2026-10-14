import { describe, expect, test } from "bun:test";

import {
  annualSalaryFigures,
  compareRegimes,
  computeDeclarationTotals,
  effectiveAmount,
  hraExemption,
  type DeclarationItemInput,
} from "@/services/tax-declaration-calc";

const item = (overrides: Partial<DeclarationItemInput>): DeclarationItemInput => ({
  section: "80C",
  declaredAmount: 0,
  verifiedAmount: null,
  status: "pending",
  details: {},
  ...overrides,
});
const flags = { seniorSelf: false, seniorParents: false };

describe("effectiveAmount", () => {
  test("declared counts until the proof deadline, then only verified", () => {
    const pending = item({ declaredAmount: 50_000 });
    expect(effectiveAmount(pending, false)).toBe(50_000);
    expect(effectiveAmount(pending, true)).toBe(0);
    expect(effectiveAmount(item({ declaredAmount: 50_000, status: "accepted", verifiedAmount: 42_000 }), true)).toBe(42_000);
    expect(effectiveAmount(item({ declaredAmount: 50_000, status: "rejected" }), false)).toBe(0);
  });
});

describe("hraExemption", () => {
  test("is the least of HRA received, rent less 10% of basic, and 50% or 40% of basic", () => {
    // Basic 6 lakh, HRA 2.4 lakh, rent 2.4 lakh: HRA 2.4L, rent - 10% basic = 1.8L, 50% basic = 3L.
    expect(hraExemption({ annualRent: 240_000, annualBasic: 600_000, annualHra: 240_000, metro: true })).toBe(180_000);
    // Non-metro with high rent: 40% of basic (2.4L) vs HRA 3L vs rent - 10% (4.4L).
    expect(hraExemption({ annualRent: 500_000, annualBasic: 600_000, annualHra: 300_000, metro: false })).toBe(240_000);
    expect(hraExemption({ annualRent: 50_000, annualBasic: 600_000, annualHra: 240_000, metro: true })).toBe(0);
  });
});

describe("computeDeclarationTotals", () => {
  test("caps each section and adds them up for the old regime", () => {
    const totals = computeDeclarationTotals({
      regime: "old",
      flags,
      afterProofDeadline: false,
      salary: null,
      items: [
        item({ section: "80C", declaredAmount: 120_000 }),
        item({ section: "80C", declaredAmount: 60_000 }),
        item({ section: "80CCD1B", declaredAmount: 70_000 }),
        item({ section: "80D_SELF", declaredAmount: 30_000 }),
        item({ section: "80E", declaredAmount: 90_000 }),
      ],
    });
    expect(totals.breakdown.find((line) => line.section === "80C")).toMatchObject({ claimed: 180_000, allowed: 150_000 });
    expect(totals.breakdown.find((line) => line.section === "80CCD1B")?.allowed).toBe(50_000);
    expect(totals.breakdown.find((line) => line.section === "80D_SELF")?.allowed).toBe(25_000);
    expect(totals.deductions).toBe(150_000 + 50_000 + 25_000 + 90_000);
  });

  test("senior citizens get the higher 80D limits", () => {
    const totals = computeDeclarationTotals({
      regime: "old",
      flags: { seniorSelf: true, seniorParents: true },
      afterProofDeadline: false,
      salary: null,
      items: [item({ section: "80D_SELF", declaredAmount: 60_000 }), item({ section: "80D_PARENTS", declaredAmount: 45_000 })],
    });
    expect(totals.deductions).toBe(50_000 + 45_000);
  });

  test("the new regime allows no deductions but keeps the previous employer", () => {
    const totals = computeDeclarationTotals({
      regime: "new",
      flags,
      afterProofDeadline: false,
      salary: null,
      items: [
        item({ section: "80C", declaredAmount: 150_000 }),
        item({ section: "PREVIOUS_EMPLOYER", declaredAmount: 300_000, details: { tdsDeducted: 12_000 } }),
      ],
    });
    expect(totals.deductions).toBe(0);
    expect(totals.oldRegimeDeductions).toBe(150_000);
    expect(totals.previousEmployer).toEqual({ gross: 300_000, tds: 12_000 });
  });

  test("previous-employer income always counts; its TDS credit needs proof after the deadline", () => {
    const previous = item({ section: "PREVIOUS_EMPLOYER", declaredAmount: 300_000, details: { tdsDeducted: 20_000 } });
    const base = { regime: "old" as const, flags, salary: null };
    expect(computeDeclarationTotals({ ...base, afterProofDeadline: false, items: [previous] }).previousEmployer).toEqual({ gross: 300_000, tds: 20_000 });
    expect(computeDeclarationTotals({ ...base, afterProofDeadline: true, items: [previous] }).previousEmployer).toEqual({ gross: 300_000, tds: 0 });
    const verified = { ...previous, status: "accepted" as const, verifiedAmount: 310_000 };
    expect(computeDeclarationTotals({ ...base, afterProofDeadline: true, items: [verified] }).previousEmployer).toEqual({ gross: 310_000, tds: 20_000 });
  });

  test("HRA uses the salary, and is zero without a fixed salary", () => {
    const base = { regime: "old" as const, flags, afterProofDeadline: false, items: [item({ section: "HRA", declaredAmount: 240_000, details: { metro: true } })] };
    expect(computeDeclarationTotals({ ...base, salary: { annualBasic: 600_000, annualHra: 240_000 } }).deductions).toBe(180_000);
    expect(computeDeclarationTotals({ ...base, salary: null }).deductions).toBe(0);
  });
});

describe("annualSalaryFigures", () => {
  test("reads basic and HRA from a monthly fixed salary", () => {
    const figures = annualSalaryFigures({
      compensationType: "fixed_salary",
      compensationAmount: 50_000,
      components: [
        { name: "HRA", kind: "earning", calc: "percent_basic", value: 40 },
        { name: "Conveyance", kind: "earning", calc: "fixed", value: 1_600 },
        { name: "Canteen", kind: "deduction", calc: "fixed", value: 500 },
      ],
    });
    expect(figures).toEqual({ annualBasic: 600_000, annualHra: 240_000, annualGross: (50_000 + 20_000 + 1_600) * 12 });
    expect(annualSalaryFigures({ compensationType: "daily", compensationAmount: 800, components: [] })).toBeNull();
  });
});

describe("compareRegimes", () => {
  test("recommends the cheaper regime", () => {
    const heavy = compareRegimes({ annualGross: 1_500_000, professionalTaxYear: 2_400, oldRegimeDeductions: 0 });
    expect(heavy.cheaper).toBe("new");
    expect(heavy.saving).toBe(heavy.old - heavy.new);
  });
});
