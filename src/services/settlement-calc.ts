import type { CompensationType, SettlementLine, SettlementLineKind } from "@/drizzle/schema";

/**
 * Pure rules for a full & final settlement. Gratuity follows the Payment of Gratuity Act: 15 days'
 * wages (on a 26-day month) per completed year, a part-year over six months counting as a year,
 * payable after five years (four years and 240 days counts, as courts have held), capped at ₹20 lakh.
 */

const DAY_MS = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const GRATUITY_CAP = 2_000_000;
export const GRATUITY_MIN_SERVICE_DAYS = 4 * 365 + 240;

/** Service from the hire date to the last working day (inclusive): whole years, leftover months and days. */
export const serviceLength = (hireDate: string, lastWorkingDay: string) => {
  const start = new Date(`${hireDate}T00:00:00Z`);
  const end = new Date(Date.parse(`${lastWorkingDay}T00:00:00Z`) + DAY_MS);
  let years = end.getUTCFullYear() - start.getUTCFullYear();
  let months = end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, totalDays: days(hireDate, lastWorkingDay) + 1 };
};

export const gratuity = (input: { hireDate: string | null; lastWorkingDay: string; monthlyBasic: number }) => {
  if (!input.hireDate || input.monthlyBasic <= 0) return { eligible: false, years: 0, amount: 0, reason: "No hire date or basic pay on record" };
  const service = serviceLength(input.hireDate, input.lastWorkingDay);
  if (service.totalDays < GRATUITY_MIN_SERVICE_DAYS) {
    return { eligible: false, years: service.years, amount: 0, reason: `${service.years} years ${service.months} months of service; gratuity needs 5 years` };
  }
  const years = service.years + (service.months >= 6 ? 1 : 0);
  const amount = Math.min(Math.round(((input.monthlyBasic * 15) / 26) * years), GRATUITY_CAP);
  return { eligible: true, years, amount, reason: `${years} years × 15/26 of monthly basic` };
};

/**
 * Gratuity earned so far, payable or not: the provision a company carries for it. Same formula as
 * gratuity(), on service to the given date. eligibleFrom is the day service reaches the payable minimum.
 */
export const accruedGratuity = (input: { hireDate: string; asOf: string; monthlyBasic: number }) => {
  const service = serviceLength(input.hireDate, input.asOf);
  const years = service.years + (service.months >= 6 ? 1 : 0);
  const amount = input.monthlyBasic > 0 ? Math.min(Math.round(((input.monthlyBasic * 15) / 26) * years), GRATUITY_CAP) : 0;
  const eligibleFrom = new Date(Date.parse(`${input.hireDate}T00:00:00Z`) + (GRATUITY_MIN_SERVICE_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  return { service, years, amount, eligible: service.totalDays >= GRATUITY_MIN_SERVICE_DAYS, eligibleFrom };
};

/** Monthly basic for gratuity: a monthly salary, or a daily or hourly rate over 26 eight-hour days. */
export const monthlyBasicOf = (input: { compensationType: CompensationType | null; compensationAmount: number }) => {
  if (input.compensationType === "fixed_salary") return input.compensationAmount;
  if (input.compensationType === "daily") return input.compensationAmount * 26;
  if (input.compensationType === "hourly") return input.compensationAmount * 8 * 26;
  return 0;
};

/** Notice days not served: from the resignation date to the last working day, against the notice due. */
export const noticeShortfallDays = (input: { resignationDate: string; noticeDays: number; lastWorkingDay: string }) =>
  Math.max(0, input.noticeDays - days(input.resignationDate, input.lastWorkingDay));

/** One day's pay: a monthly salary over 26 working days, the daily wage, or eight hours of an hourly rate. */
export const defaultDailyRate = (input: { compensationType: CompensationType | null; compensationAmount: number; hoursPerDay?: number }) => {
  if (input.compensationType === "fixed_salary") return round2(input.compensationAmount / 26);
  if (input.compensationType === "daily") return input.compensationAmount;
  if (input.compensationType === "hourly") return round2(input.compensationAmount * (input.hoursPerDay ?? 8));
  return 0;
};

const DEDUCTIONS: SettlementLineKind[] = ["notice_recovery", "loan_recovery", "other_deduction"];
export const isDeduction = (kind: SettlementLineKind) => DEDUCTIONS.includes(kind);

export const settlementTotals = (lines: SettlementLine[]) => {
  let earnings = 0;
  let deductions = 0;
  for (const line of lines) {
    const cents = Math.round(Number(line.amount) * 100);
    if (isDeduction(line.kind)) deductions += cents;
    else earnings += cents;
  }
  return { totalEarnings: (earnings / 100).toFixed(2), totalDeductions: (deductions / 100).toFixed(2), netPayable: ((earnings - deductions) / 100).toFixed(2) };
};

const round2 = (value: number) => Math.round(value * 100) / 100;
