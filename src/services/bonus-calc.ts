/**
 * Statutory bonus under the Payment of Bonus Act, 1965, for one employee and one financial year.
 * Amounts in rupees. Worked out from finalized payroll: each month's basic + DA earned.
 */

/** Employees earning more than this a month (basic + DA) are not covered. */
export const BONUS_ELIGIBILITY_CEILING = 21_000;
/** Monthly wages above this count as this much (or the state minimum wage, when the company enters it). */
export const BONUS_CALCULATION_CEILING = 7_000;
export const BONUS_MIN_PERCENT = 8.33;
export const BONUS_MAX_PERCENT = 20;
/** Days worked in the year below which no bonus is due. */
export const BONUS_MIN_DAYS = 30;
/** The Act's minimum bonus for a covered employee, when 8.33% comes to less. */
export const BONUS_MIN_AMOUNT = 100;

/** A component counts as dearness allowance (part of bonus wages) when its name says so. */
export const isDearnessAllowance = (name: string) => /dearness|^\s*d\.?\s*a\.?\s*$/i.test(name);

export type BonusMonth = { month: string; wage: number; days: number };

export type BonusRules = { percentage: number; eligibilityCeiling: number; calculationCeiling: number };

export type BonusResult = {
  eligible: boolean;
  reason: string;
  /** The highest month's basic + DA, which decides coverage. */
  monthlyWage: number;
  daysWorked: number;
  /** Each month's wage capped at the calculation ceiling, summed. */
  bonusWages: number;
  amount: number;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export const computeBonus = (months: BonusMonth[], rules: BonusRules): BonusResult => {
  const monthlyWage = round2(Math.max(0, ...months.map((m) => m.wage)));
  const daysWorked = Math.round(months.reduce((sum, m) => sum + m.days, 0) * 10) / 10;
  const bonusWages = round2(months.reduce((sum, m) => sum + Math.min(m.wage, rules.calculationCeiling), 0));
  const base = { monthlyWage, daysWorked, bonusWages };

  if (monthlyWage > rules.eligibilityCeiling) {
    return { ...base, eligible: false, amount: 0, reason: `Earns over ${rules.eligibilityCeiling.toLocaleString("en-IN")} a month (basic + DA)` };
  }
  if (daysWorked < BONUS_MIN_DAYS) {
    return { ...base, eligible: false, amount: 0, reason: `Worked ${daysWorked} days, under ${BONUS_MIN_DAYS}` };
  }
  const calculated = Math.round((bonusWages * rules.percentage) / 100);
  const amount = Math.max(calculated, BONUS_MIN_AMOUNT);
  return {
    ...base,
    eligible: true,
    amount,
    reason: amount > calculated ? `Raised to the minimum bonus of ${BONUS_MIN_AMOUNT}` : `${rules.percentage}% of ${bonusWages.toFixed(2)}`,
  };
};
