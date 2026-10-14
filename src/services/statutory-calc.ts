import type { StatutoryBreakup, TaxRegime } from "@/drizzle/schema";

/**
 * India statutory payroll rules. Every amount is in rupees. The rates and slabs below
 * follow the rules for FY 2025-26 onward and must be reviewed when the law changes.
 */

export type StatutorySettings = {
  pfEnabled: boolean;
  pfWageCeiling: number;
  pfCapWages: boolean;
  esiEnabled: boolean;
  esiWageCeiling: number;
  ptEnabled: boolean;
  ptState: string | null;
  ptFlatAmount: number | null;
  tdsEnabled: boolean;
};

export type EmployeeStatutory = {
  pfApplicable: boolean;
  esiApplicable: boolean;
  gender: string | null;
  taxRegime: TaxRegime;
  declaredDeductions: number;
};

/** Earlier finalized runs of the same financial year, for one employee. */
export type YearToDate = { gross: number; tds: number; professionalTax: number };

export const EMPTY_YTD: YearToDate = { gross: 0, tds: 0, professionalTax: 0 };

const PF_RATE = 12;
const EPS_RATE = 8.33;
const EPS_WAGE_CAP = 15_000;
const PF_ADMIN_RATE = 0.5;
const EDLI_RATE = 0.5;
const ESI_EMPLOYEE_RATE = 0.75;
const ESI_EMPLOYER_RATE = 3.25;
const CESS_RATE = 0.04;

const rupees = (value: number) => Math.round(value);
const round2 = (value: number) => Math.round(value * 100) / 100;

export const computePf = (wages: number, settings: StatutorySettings, employee: EmployeeStatutory) => {
  const empty = { pfWages: 0, pfEmployee: 0, pfEps: 0, pfEpfDiff: 0, pfAdmin: 0, pfEdli: 0, epsWages: 0 };
  if (!settings.pfEnabled || !employee.pfApplicable || wages <= 0) return empty;
  const contributionWages = settings.pfCapWages ? Math.min(wages, settings.pfWageCeiling) : wages;
  const epsWages = Math.min(wages, EPS_WAGE_CAP);
  const pfEmployee = rupees((contributionWages * PF_RATE) / 100);
  const employerShare = rupees((contributionWages * PF_RATE) / 100);
  const pfEps = Math.min(rupees((epsWages * EPS_RATE) / 100), employerShare);
  return {
    pfWages: rupees(contributionWages),
    pfEmployee,
    pfEps,
    pfEpfDiff: employerShare - pfEps,
    pfAdmin: rupees((contributionWages * PF_ADMIN_RATE) / 100),
    pfEdli: rupees((epsWages * EDLI_RATE) / 100),
    epsWages: rupees(epsWages),
  };
};

/**
 * ESI applies while the monthly wage entitlement is within the ceiling. Contributions are
 * on the wages actually earned in the month and are rounded up to the next rupee.
 */
export const computeEsi = (
  earnedWages: number,
  entitlement: number,
  settings: StatutorySettings,
  employee: EmployeeStatutory,
) => {
  if (!settings.esiEnabled || !employee.esiApplicable || earnedWages <= 0) {
    return { esiWages: 0, esiEmployee: 0, esiEmployer: 0 };
  }
  if (entitlement > settings.esiWageCeiling) return { esiWages: 0, esiEmployee: 0, esiEmployer: 0 };
  return {
    esiWages: rupees(earnedWages),
    esiEmployee: Math.ceil((earnedWages * ESI_EMPLOYEE_RATE) / 100 - 1e-9),
    esiEmployer: Math.ceil((earnedWages * ESI_EMPLOYER_RATE) / 100 - 1e-9),
  };
};

type PtSlab = { upTo: number; amount: number; februaryAmount?: number };

const ptTable = (state: string, gender: string | null): PtSlab[] => {
  switch (state) {
    case "MH":
      return gender === "female"
        ? [{ upTo: 25_000, amount: 0 }, { upTo: Infinity, amount: 200, februaryAmount: 300 }]
        : [
            { upTo: 7_500, amount: 0 },
            { upTo: 10_000, amount: 175 },
            { upTo: Infinity, amount: 200, februaryAmount: 300 },
          ];
    case "KA":
      return [{ upTo: 24_999, amount: 0 }, { upTo: Infinity, amount: 200 }];
    case "WB":
      return [
        { upTo: 10_000, amount: 0 },
        { upTo: 15_000, amount: 110 },
        { upTo: 25_000, amount: 130 },
        { upTo: 40_000, amount: 150 },
        { upTo: Infinity, amount: 200 },
      ];
    case "GJ":
      return [{ upTo: 12_000, amount: 0 }, { upTo: Infinity, amount: 200 }];
    case "TG":
    case "AP":
      return [{ upTo: 15_000, amount: 0 }, { upTo: 20_000, amount: 150 }, { upTo: Infinity, amount: 200 }];
    default:
      return [];
  }
};

export const PT_STATES: { code: string; name: string }[] = [
  { code: "MH", name: "Maharashtra" },
  { code: "KA", name: "Karnataka" },
  { code: "WB", name: "West Bengal" },
  { code: "GJ", name: "Gujarat" },
  { code: "TG", name: "Telangana" },
  { code: "AP", name: "Andhra Pradesh" },
  { code: "FLAT", name: "Other state (fixed monthly amount)" },
];

export const computeProfessionalTax = (
  gross: number,
  periodEnd: string,
  settings: StatutorySettings,
  employee: EmployeeStatutory,
) => {
  if (!settings.ptEnabled || !settings.ptState || gross <= 0) return 0;
  if (settings.ptState === "FLAT") return rupees(settings.ptFlatAmount ?? 0);
  const slab = ptTable(settings.ptState, employee.gender).find((item) => gross <= item.upTo);
  if (!slab) return 0;
  const isFebruary = periodEnd.slice(5, 7) === "02";
  return isFebruary && slab.februaryAmount !== undefined ? slab.februaryAmount : slab.amount;
};

type TaxSlab = { upTo: number; rate: number };

const NEW_SLABS: TaxSlab[] = [
  { upTo: 400_000, rate: 0 },
  { upTo: 800_000, rate: 5 },
  { upTo: 1_200_000, rate: 10 },
  { upTo: 1_600_000, rate: 15 },
  { upTo: 2_000_000, rate: 20 },
  { upTo: 2_400_000, rate: 25 },
  { upTo: Infinity, rate: 30 },
];

const OLD_SLABS: TaxSlab[] = [
  { upTo: 250_000, rate: 0 },
  { upTo: 500_000, rate: 5 },
  { upTo: 1_000_000, rate: 20 },
  { upTo: Infinity, rate: 30 },
];

const slabTax = (income: number, slabs: TaxSlab[]) => {
  let tax = 0;
  let lower = 0;
  for (const slab of slabs) {
    if (income > lower) tax += ((Math.min(income, slab.upTo) - lower) * slab.rate) / 100;
    lower = slab.upTo;
  }
  return tax;
};

export const STANDARD_DEDUCTION: Record<TaxRegime, number> = { new: 75_000, old: 50_000 };

/**
 * Annual income tax on salary income, including the section 87A rebate (with marginal
 * relief in the new regime) and 4% cess. Surcharge for incomes above Rs 50 lakh is not applied.
 */
export const annualTax = (
  grossSalary: number,
  regime: TaxRegime,
  professionalTaxYear: number,
  declaredDeductions: number,
) => {
  const standard = STANDARD_DEDUCTION[regime];
  const deductions =
    regime === "old" ? standard + professionalTaxYear + Math.max(declaredDeductions, 0) : standard;
  const taxable = Math.max(grossSalary - deductions, 0);
  let tax: number;
  if (regime === "new") {
    tax = slabTax(taxable, NEW_SLABS);
    if (taxable <= 1_200_000) tax = 0;
    else tax = Math.min(tax, taxable - 1_200_000);
  } else {
    tax = slabTax(taxable, OLD_SLABS);
    if (taxable <= 500_000) tax = 0;
  }
  const cess = tax * CESS_RATE;
  return { taxable, deductions, tax: round2(tax), cess: round2(cess), total: rupees(tax + cess) };
};

/** Months of the financial year left, counting the month of the given date. */
export const monthsRemaining = (periodEnd: string) => {
  const month = Number(periodEnd.slice(5, 7));
  const position = ((month - 4 + 12) % 12) + 1;
  return 13 - position;
};

export const financialYearOf = (date: string) => {
  const year = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  return { start, label: `${start}-${String(start + 1).slice(2)}`, from: `${start}-04-01`, to: `${start + 1}-03-31` };
};

/** Tax to deduct this month: projected annual tax, less tax already deducted, over the months left. */
export const computeMonthlyTds = (
  gross: number,
  periodEnd: string,
  professionalTax: number,
  settings: StatutorySettings,
  employee: EmployeeStatutory,
  ytd: YearToDate,
) => {
  if (!settings.tdsEnabled || gross <= 0) return 0;
  const remaining = monthsRemaining(periodEnd);
  const projectedGross = ytd.gross + gross * remaining;
  const projectedPt = ytd.professionalTax + professionalTax * remaining;
  const { total } = annualTax(projectedGross, employee.taxRegime, projectedPt, employee.declaredDeductions);
  return Math.max(0, rupees((total - ytd.tds) / remaining));
};

export const emptyBreakup = (regime: TaxRegime): StatutoryBreakup => ({
  pfWages: 0,
  pfEmployee: 0,
  pfEps: 0,
  pfEpfDiff: 0,
  pfAdmin: 0,
  pfEdli: 0,
  epsWages: 0,
  esiWages: 0,
  esiEmployee: 0,
  esiEmployer: 0,
  professionalTax: 0,
  tds: 0,
  taxRegime: regime,
});
