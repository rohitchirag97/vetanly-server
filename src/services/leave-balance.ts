/**
 * Leave balances, worked out from history so no year-end job is needed.
 *
 * Yearly types: balance = allowance + carried in + credits - used. Whatever is left at the end
 * of a year moves into the next one, up to the type's carry-forward cap (none when the cap is null).
 *
 * Comp-off types have no allowance: each credit is one worked off-day, valid for `validityDays`.
 */

const DAY_MS = 86_400_000;
const round = (value: number) => Math.round(value * 10) / 10;

/** Days carried into `year` from every year since `firstYear`, each capped at `cap`. */
export const carriedInto = (input: {
  year: number;
  firstYear: number;
  allowance: number;
  cap: number | null;
  usedByYear: Map<number, number>;
  creditsByYear: Map<number, number>;
}) => {
  if (input.cap === null || input.cap <= 0) return 0;
  let carry = 0;
  for (let year = input.firstYear; year < input.year; year++) {
    const left = input.allowance + carry + (input.creditsByYear.get(year) ?? 0) - (input.usedByYear.get(year) ?? 0);
    carry = Math.min(input.cap, Math.max(0, left));
  }
  return round(carry);
};

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Comp-off days still available on `asOf`. Credits past their validity are gone; leave taken
 * before the oldest still-valid credit is taken to have used up older, now expired credits.
 */
export const compOffAvailable = (input: {
  credits: { workedOn: string; days: number }[];
  taken: { startDate: string; days: number }[];
  asOf: string;
  validityDays: number | null;
}) => {
  const valid = input.credits.filter(
    (credit) =>
      credit.workedOn <= input.asOf &&
      (input.validityDays === null || addDays(credit.workedOn, input.validityDays) >= input.asOf),
  );
  if (valid.length === 0) return 0;
  const since = valid.reduce((oldest, credit) => (credit.workedOn < oldest ? credit.workedOn : oldest), valid[0].workedOn);
  const earned = valid.reduce((total, credit) => total + credit.days, 0);
  const used = input.taken.filter((leave) => leave.startDate >= since).reduce((total, leave) => total + leave.days, 0);
  return round(Math.max(0, earned - used));
};
