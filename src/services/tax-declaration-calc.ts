import type { SalaryComponent, TaxDeclarationItemStatus, TaxDeclarationSection, TaxRegime } from "@/drizzle/schema";
import { annualTax } from "@/services/statutory-calc";

/**
 * Old-regime deductions an employee can declare, with the limits for FY 2025-26 onward. The new
 * regime allows none of these; only previous-employer income and TDS carry over in both regimes.
 * Review the limits when the law changes, as with statutory-calc.ts.
 */

export const SECTIONS: Record<
  TaxDeclarationSection,
  { label: string; kinds: { value: string; label: string }[]; limit: (flags: SeniorFlags) => number | null }
> = {
  "80C": {
    label: "Section 80C investments",
    kinds: [
      { value: "ppf", label: "Public Provident Fund (PPF)" },
      { value: "elss", label: "ELSS mutual funds" },
      { value: "lic", label: "Life insurance premium" },
      { value: "epf_vpf", label: "Voluntary PF (VPF)" },
      { value: "nsc", label: "National Savings Certificate" },
      { value: "tuition_fees", label: "Children's tuition fees" },
      { value: "home_loan_principal", label: "Home loan principal" },
      { value: "sukanya", label: "Sukanya Samriddhi" },
      { value: "tax_saver_fd", label: "5-year tax-saver FD" },
      { value: "other", label: "Other 80C" },
    ],
    limit: () => 150_000,
  },
  "80CCD1B": {
    label: "NPS, section 80CCD(1B)",
    kinds: [{ value: "nps", label: "National Pension System" }],
    limit: () => 50_000,
  },
  "80D_SELF": {
    label: "Health insurance, self and family (80D)",
    kinds: [
      { value: "health_insurance", label: "Health insurance premium" },
      { value: "preventive_checkup", label: "Preventive health check-up" },
    ],
    limit: (flags) => (flags.seniorSelf ? 50_000 : 25_000),
  },
  "80D_PARENTS": {
    label: "Health insurance, parents (80D)",
    kinds: [
      { value: "health_insurance", label: "Health insurance premium" },
      { value: "preventive_checkup", label: "Preventive health check-up" },
    ],
    limit: (flags) => (flags.seniorParents ? 50_000 : 25_000),
  },
  HRA: {
    label: "House rent (HRA exemption)",
    kinds: [{ value: "rent", label: "Rent paid" }],
    limit: () => null,
  },
  "24B": {
    label: "Home loan interest, section 24(b)",
    kinds: [{ value: "home_loan_interest", label: "Interest on self-occupied home loan" }],
    limit: () => 200_000,
  },
  "80E": {
    label: "Education loan interest (80E)",
    kinds: [{ value: "education_loan_interest", label: "Interest on education loan" }],
    limit: () => null,
  },
  "80TTA": {
    label: "Savings account interest (80TTA)",
    kinds: [{ value: "savings_interest", label: "Savings bank interest" }],
    limit: () => 10_000,
  },
  PREVIOUS_EMPLOYER: {
    label: "Previous employer this year",
    kinds: [{ value: "salary_and_tds", label: "Salary and TDS from previous employer" }],
    limit: () => null,
  },
};

export type SeniorFlags = { seniorSelf: boolean; seniorParents: boolean };

export type DeclarationItemInput = {
  section: TaxDeclarationSection;
  declaredAmount: number;
  verifiedAmount: number | null;
  status: TaxDeclarationItemStatus;
  details: Record<string, string | number | boolean | null>;
};

/**
 * The amount that counts for TDS: until the proof deadline, what was declared (unless rejected);
 * after it, only what was verified. An accepted item counts at its verified amount.
 */
export const effectiveAmount = (item: DeclarationItemInput, afterProofDeadline: boolean) => {
  if (item.status === "rejected") return 0;
  if (item.status === "accepted") return item.verifiedAmount ?? item.declaredAmount;
  return afterProofDeadline ? 0 : item.declaredAmount;
};

/** HRA exemption: the least of HRA received, rent minus 10% of basic, and 50% (metro) or 40% of basic. */
export const hraExemption = (input: { annualRent: number; annualBasic: number; annualHra: number; metro: boolean }) => {
  if (input.annualRent <= 0 || input.annualHra <= 0 || input.annualBasic <= 0) return 0;
  return Math.max(
    0,
    Math.min(
      input.annualHra,
      input.annualRent - 0.1 * input.annualBasic,
      (input.metro ? 0.5 : 0.4) * input.annualBasic,
    ),
  );
};

/** Basic pay and HRA for a full year, from a fixed monthly salary. Null when pay is daily or hourly. */
export const annualSalaryFigures = (input: {
  compensationType: string | null;
  compensationAmount: number | null;
  components: SalaryComponent[];
}) => {
  if (input.compensationType !== "fixed_salary" || !input.compensationAmount) return null;
  const basic = input.compensationAmount;
  const earning = (component: SalaryComponent) =>
    component.calc === "percent_basic" ? (basic * component.value) / 100 : component.value;
  const earnings = input.components.filter((component) => component.kind === "earning");
  const hra = earnings
    .filter((component) => /\bhra\b|house\s*rent/i.test(component.name))
    .reduce((sum, component) => sum + earning(component), 0);
  const gross = basic + earnings.reduce((sum, component) => sum + earning(component), 0);
  return { annualBasic: basic * 12, annualHra: hra * 12, annualGross: gross * 12 };
};

export type DeductionBreakdown = { section: TaxDeclarationSection; label: string; claimed: number; allowed: number };

/** Totals one declaration into the old-regime deduction and the previous-employer carry-over. */
export const computeDeclarationTotals = (input: {
  regime: TaxRegime;
  flags: SeniorFlags;
  items: DeclarationItemInput[];
  afterProofDeadline: boolean;
  salary: { annualBasic: number; annualHra: number } | null;
}) => {
  const bySection = new Map<TaxDeclarationSection, { amount: number; items: DeclarationItemInput[] }>();
  let previousGross = 0;
  let previousTds = 0;
  for (const item of input.items) {
    const amount = effectiveAmount(item, input.afterProofDeadline);
    if (item.section === "PREVIOUS_EMPLOYER") {
      // Income always counts, even unproven: leaving it out would deduct too little tax. Only the
      // credit for TDS already paid follows the proof rules, so unproven TDS is not credited.
      previousGross += item.status === "accepted" ? (item.verifiedAmount ?? item.declaredAmount) : item.declaredAmount;
      if (amount > 0) previousTds += Number(item.details.tdsDeducted ?? 0) || 0;
      continue;
    }
    const entry = bySection.get(item.section) ?? { amount: 0, items: [] };
    entry.amount += amount;
    entry.items.push(item);
    bySection.set(item.section, entry);
  }

  const breakdown: DeductionBreakdown[] = [];
  for (const [section, entry] of bySection) {
    let allowed: number;
    if (section === "HRA") {
      const metro = entry.items.some((item) => item.details.metro === true);
      allowed = input.salary
        ? hraExemption({ annualRent: entry.amount, annualBasic: input.salary.annualBasic, annualHra: input.salary.annualHra, metro })
        : 0;
    } else {
      const limit = SECTIONS[section].limit(input.flags);
      allowed = limit === null ? entry.amount : Math.min(entry.amount, limit);
    }
    breakdown.push({ section, label: SECTIONS[section].label, claimed: round2(entry.amount), allowed: round2(allowed) });
  }

  const oldRegimeDeductions = round2(breakdown.reduce((sum, line) => sum + line.allowed, 0));
  return {
    // The new regime allows none of these deductions.
    deductions: input.regime === "old" ? oldRegimeDeductions : 0,
    oldRegimeDeductions,
    breakdown,
    previousEmployer: { gross: round2(previousGross), tds: round2(previousTds) },
  };
};

/** Estimated full-year tax under each regime, so the employee can pick the cheaper one. */
export const compareRegimes = (input: { annualGross: number; professionalTaxYear: number; oldRegimeDeductions: number }) => {
  const oldTax = annualTax(input.annualGross, "old", input.professionalTaxYear, input.oldRegimeDeductions).total;
  const newTax = annualTax(input.annualGross, "new", input.professionalTaxYear, 0).total;
  return { old: oldTax, new: newTax, cheaper: (oldTax < newTax ? "old" : "new") as TaxRegime, saving: Math.abs(oldTax - newTax) };
};

const round2 = (value: number) => Math.round(value * 100) / 100;
