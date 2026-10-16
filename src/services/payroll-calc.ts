import type {
  CompensationType,
  LateFineMethod,
  OffDayOutcome,
  OffDayWorkPolicy,
  OvertimeCalculationMethod,
  SalaryComponent,
} from "@/drizzle/schema";
import type { DailyAttendance } from "@/services/attendance.services";
import {
  computeEsi,
  computeMonthlyTds,
  computePf,
  computeProfessionalTax,
  emptyBreakup,
  type EmployeeStatutory,
  type StatutorySettings,
  type YearToDate,
} from "@/services/statutory-calc";
import type { StatutoryBreakup } from "@/drizzle/schema";

export type CalcSettings = {
  overtimeCalculationMethod: OvertimeCalculationMethod;
  overtimeFixedAmountPerHour: number | null;
  overtimeHourlyRateMultiplier: number;
  overtimeHoursPerWorkday: number | null;
  lateFineMethod: LateFineMethod;
  lateFineAmount: number | null;
  lateFineCapPerPayPeriod: number | null;
  weeklyOffDays: number[];
  autoDeductLoans: boolean;
  paidHolidays: boolean;
  overtimeApprovalRequired: boolean;
  offDayWorkPolicy: OffDayWorkPolicy;
  weeklyOffWorkMultiplier: number;
  holidayWorkMultiplier: number;
};

export type CalcLeave = { startDate: string; endDate: string; isHalfDay: boolean; isPaid: boolean };

export type CalcLoan = {
  recoverableId: string;
  label: string;
  installmentCents: number;
  outstandingCents: number;
};

export type CalcInput = {
  periodStart: string;
  periodEnd: string;
  hireDate: string | null;
  compensationType: CompensationType;
  compensationAmount: number;
  components: SalaryComponent[];
  shiftExpectedMinutes: number | null;
  settings: CalcSettings;
  days: DailyAttendance[];
  holidays: string[];
  leaves: CalcLeave[];
  loans: CalcLoan[];
  /** Approved overtime minutes by date; only used when approval is required. */
  overtimeApprovals?: Map<string, number>;
  /**
   * Per-date work or off from the shift roster, for employees on a rotation or with day overrides.
   * A rostered date replaces the company weekly off for that date; dates not listed keep it.
   */
  rosterDays?: Map<string, "work" | "off">;
  /** Decisions for days worked on a weekly off or holiday, by date; undecided days follow the policy. */
  offDayOutcomes?: Map<string, OffDayOutcome>;
  /** A bonus paid with this salary: taxable, but not wages for PF, ESI or professional tax. */
  bonusCents?: number;
  statutory?: { settings: StatutorySettings; employee: EmployeeStatutory; ytd: YearToDate };
};

export type CalcResult = {
  workingDays: number;
  presentDays: number;
  halfDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
  incompleteDays: number;
  workedMinutes: number;
  overtimeMinutes: number;
  lateCount: number;
  lateMinutes: number;
  basePayCents: number;
  overtimePayCents: number;
  allowancesPayCents: number;
  bonusPayCents: number;
  /** Paid off-day work: days (half days count 0.5) and their pay. */
  offDayDays: number;
  offDayPayCents: number;
  /** Worked off-days with no decision yet, so not paid in this run. */
  offDayPending: { date: string; days: number }[];
  grossPayCents: number;
  lateFineCents: number;
  componentDeductionsCents: number;
  componentLines: { name: string; kind: "earning" | "deduction"; amountCents: number }[];
  loanLines: { recoverableId: string; label: string; amountCents: number }[];
  loanDeductionCents: number;
  totalDeductionsCents: number;
  netPayCents: number;
  statutory: StatutoryBreakup | null;
};

const DAY_MS = 86_400_000;
const DEFAULT_DAY_HOURS = 8;

const cents = (value: number) => Math.round(value * 100);

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * Minutes worked after the shift break. Shifts store only the break's length, not when it is
 * taken, so the break is deducted in proportion to how much of the shift was covered: a full
 * shift loses the whole break, a one-hour visit only a few minutes of it.
 */
export const workedAfterBreak = (elapsedMinutes: number, shiftSpanMinutes: number, breakMinutes: number) => {
  const breakTaken =
    shiftSpanMinutes > 0 ? Math.min(breakMinutes, Math.round((breakMinutes * elapsedMinutes) / shiftSpanMinutes)) : breakMinutes;
  return Math.max(0, elapsedMinutes - breakTaken);
};

export const eachDate = (from: string, to: string): string[] => {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= end; time += DAY_MS) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
};

/**
 * Pay rules:
 * - Weekly-off days are not working days. Every other day in the period is one. For employees on a
 *   shift rotation, their rostered off days replace the weekly off, and rostered workdays count even
 *   when they fall on the company weekly off.
 * - Company holidays are skipped entirely, unless the organization pays holidays: then
 *   each counts as a working day and a fully payable one (daily and hourly staff get a day's pay).
 * - A day with punches follows its attendance status (present, half day, absent).
 *   A check-in without a check-out is treated as absent and counted as incomplete.
 * - A day without punches is paid or unpaid leave if an approved leave covers it,
 *   otherwise absent. Days before the hire date are never payable.
 * - fixed_salary: amount per pay period, prorated by payable / working days.
 *   daily: amount per payable day. hourly: amount per worked hour.
 * - Overtime is the time worked beyond the shift on full days. For hourly staff the
 *   straight-time hours are already in base pay, so only the premium is added.
 * - Fines and loan installments never take net pay below zero.
 * - Allowances (earnings) add to gross: fixed ones are prorated by payable / working
 *   days, percentage ones are a share of the base pay earned. Percentage deductions
 *   (PF, ESI) are also a share of base pay; fixed deductions are taken in full.
 *   Deductions never exceed the pay left after the late fine.
 */
export const calculatePayroll = (input: CalcInput): CalcResult => {
  const { settings, compensationAmount: amount, compensationType: type } = input;
  const dayMap = new Map(input.days.map((day) => [day.date, day]));
  const hoursPerDay =
    (input.shiftExpectedMinutes ? input.shiftExpectedMinutes / 60 : null) ??
    settings.overtimeHoursPerWorkday ??
    DEFAULT_DAY_HOURS;

  let workingDays = 0;
  let payable = 0;
  let present = 0;
  let half = 0;
  let paidLeave = 0;
  let unpaidLeave = 0;
  let paidHolidays = 0;
  let absent = 0;
  let incomplete = 0;
  let workedMinutes = 0;
  let overtimeMinutes = 0;
  let lateCount = 0;
  let lateMinutes = 0;

  const holidaySet = new Set(input.holidays);
  const offDayWork: { kind: "weekly_off" | "holiday"; days: number; minutes: number }[] = [];
  const offDayPending: CalcResult["offDayPending"] = [];

  for (const date of eachDate(input.periodStart, input.periodEnd)) {
    const rostered = input.rosterDays?.get(date);
    const weeklyOff = rostered === "off" || (rostered !== "work" && settings.weeklyOffDays.includes(weekdayOf(date)));
    // Work on an off day is paid only when decided (or the policy says) "pay"; comp-off and "none" are not.
    if (weeklyOff || holidaySet.has(date)) {
      const worked = dayMap.get(date);
      const days = worked?.status === "present" ? 1 : worked?.status === "half_day" ? 0.5 : 0;
      if (days > 0 && (!input.hireDate || date >= input.hireDate)) {
        const outcome = input.offDayOutcomes?.get(date) ?? (settings.offDayWorkPolicy === "pay" ? "pay" : null);
        if (outcome === "pay") {
          offDayWork.push({ kind: holidaySet.has(date) ? "holiday" : "weekly_off", days, minutes: worked?.workedMinutes ?? 0 });
        } else if (outcome === null) {
          offDayPending.push({ date, days });
        }
      }
    }
    if (weeklyOff) continue;
    if (holidaySet.has(date)) {
      if (settings.paidHolidays) {
        workingDays += 1;
        if (!input.hireDate || date >= input.hireDate) {
          payable += 1;
          paidHolidays += 1;
        }
      }
      continue;
    }
    workingDays += 1;
    if (input.hireDate && date < input.hireDate) continue;

    const day = dayMap.get(date);
    if (day) {
      workedMinutes += day.workedMinutes ?? 0;
      if (day.lateMinutes > 0) {
        lateCount += 1;
        lateMinutes += day.lateMinutes;
      }
      if (day.status === "present") {
        present += 1;
        payable += 1;
        overtimeMinutes += settings.overtimeApprovalRequired
          ? Math.min(day.overtimeMinutes, input.overtimeApprovals?.get(date) ?? 0)
          : day.overtimeMinutes;
      } else if (day.status === "half_day") {
        half += 1;
        payable += 0.5;
      } else {
        absent += 1;
        if (day.status === "incomplete") incomplete += 1;
      }
      continue;
    }

    const leave = input.leaves.find((item) => item.startDate <= date && date <= item.endDate);
    if (leave) {
      const weight = leave.isHalfDay ? 0.5 : 1;
      if (leave.isPaid) {
        paidLeave += weight;
        payable += weight;
      } else {
        unpaidLeave += weight;
      }
      absent += 1 - weight;
    } else {
      absent += 1;
    }
  }

  const perDayRate =
    type === "fixed_salary"
      ? workingDays > 0
        ? amount / workingDays
        : 0
      : type === "daily"
        ? amount
        : amount * hoursPerDay;
  const hourlyRate = type === "hourly" ? amount : perDayRate / hoursPerDay;

  let basePay: number;
  if (type === "fixed_salary") basePay = workingDays > 0 ? (amount * payable) / workingDays : amount;
  else if (type === "daily") basePay = amount * payable;
  else basePay = amount * (workedMinutes / 60) + amount * hoursPerDay * (paidLeave + paidHolidays);

  const otHours = overtimeMinutes / 60;
  let overtimePay = 0;
  if (settings.overtimeCalculationMethod === "fixed_per_hour") {
    overtimePay = (settings.overtimeFixedAmountPerHour ?? 0) * otHours;
  } else if (settings.overtimeCalculationMethod === "hourly_rate_multiplier") {
    const multiplier = settings.overtimeHourlyRateMultiplier - (type === "hourly" ? 1 : 0);
    overtimePay = hourlyRate * Math.max(multiplier, 0) * otHours;
  } else {
    const hoursForDay = settings.overtimeHoursPerWorkday ?? hoursPerDay;
    overtimePay = (otHours / hoursForDay) * perDayRate;
  }

  const basePayCents = cents(basePay);
  const overtimePayCents = cents(overtimePay);

  // A paid holiday already earned one day's pay, so working it adds the multiplier minus that day.
  const offDayPay = offDayWork.reduce((total, work) => {
    const multiplier = Math.max(
      0,
      work.kind === "holiday"
        ? settings.holidayWorkMultiplier - (settings.paidHolidays ? 1 : 0)
        : settings.weeklyOffWorkMultiplier,
    );
    return total + (type === "hourly" ? (work.minutes / 60) * hourlyRate : perDayRate * work.days) * multiplier;
  }, 0);
  const offDayPayCents = cents(offDayPay);

  // Allowances are monthly amounts prorated by attendance; percentages apply to the
  // base pay actually earned. Deductions are not prorated, but never exceed what remains.
  const attendanceRatio = workingDays > 0 ? Math.min(payable / workingDays, 1) : 1;
  const earningLines: CalcResult["componentLines"] = [];
  const deductionLines: CalcResult["componentLines"] = [];
  for (const component of input.components) {
    if (component.kind === "earning") {
      const amount =
        component.calc === "percent_basic"
          ? (basePay * component.value) / 100
          : component.value * attendanceRatio;
      earningLines.push({ name: component.name, kind: "earning", amountCents: cents(amount) });
    }
  }
  const allowancesPayCents = earningLines.reduce((sum, line) => sum + line.amountCents, 0);
  // A bonus is paid inside gross (it is taxable) but stays out of PF, ESI and professional tax wages.
  const bonusPayCents = Math.max(0, Math.round(input.bonusCents ?? 0));
  const grossPayCents = basePayCents + overtimePayCents + offDayPayCents + allowancesPayCents + bonusPayCents;

  let fineCents = 0;
  if (settings.lateFineMethod === "fixed_per_occurrence") {
    fineCents = cents((settings.lateFineAmount ?? 0) * lateCount);
  } else if (settings.lateFineMethod === "per_minute") {
    fineCents = cents((settings.lateFineAmount ?? 0) * lateMinutes);
  }
  if (settings.lateFineCapPerPayPeriod !== null) {
    fineCents = Math.min(fineCents, cents(settings.lateFineCapPerPayPeriod));
  }
  fineCents = Math.min(fineCents, grossPayCents);

  let available = grossPayCents - fineCents;

  // Statutory deductions come first. Manual components that duplicate an enabled
  // statutory deduction are skipped, so nothing is taken twice.
  const stat = input.statutory;
  let breakup: StatutoryBreakup | null = null;
  const duplicates: RegExp[] = [];
  if (stat) {
    const gross = (grossPayCents - bonusPayCents) / 100;
    const entitlement = fullMonthEntitlement({
      type,
      amount,
      workingDays,
      hoursPerDay,
      components: input.components,
    });
    const pf = computePf(basePayCents / 100, stat.settings, stat.employee);
    const esi = computeEsi(gross, entitlement, stat.settings, stat.employee);
    const professionalTax = computeProfessionalTax(gross, input.periodEnd, stat.settings, stat.employee);
    // Deductions that reduce taxable pay are already inside gross; PT is passed separately.
    const tds = computeMonthlyTds(gross, input.periodEnd, professionalTax, stat.settings, stat.employee, stat.ytd, bonusPayCents / 100);
    breakup = {
      ...emptyBreakup(stat.employee.taxRegime),
      ...pf,
      ...esi,
      professionalTax,
      tds,
    };
    const statutoryLines: [string, number, boolean][] = [
      ["Provident fund (employee)", breakup.pfEmployee, stat.settings.pfEnabled],
      ["ESI (employee)", breakup.esiEmployee, stat.settings.esiEnabled],
      ["Professional tax", breakup.professionalTax, stat.settings.ptEnabled],
      ["Income tax (TDS)", breakup.tds, stat.settings.tdsEnabled],
    ];
    if (stat.settings.pfEnabled) duplicates.push(/\b(pf|provident)/i);
    if (stat.settings.esiEnabled) duplicates.push(/\besi\b/i);
    if (stat.settings.ptEnabled) duplicates.push(/professional\s*tax|^pt$/i);
    if (stat.settings.tdsEnabled) duplicates.push(/\btds\b|income\s*tax/i);
    for (const [name, amountRupees, enabled] of statutoryLines) {
      if (!enabled) continue;
      const amountCents = Math.min(cents(amountRupees), available);
      if (amountCents <= 0) continue;
      deductionLines.push({ name, kind: "deduction", amountCents });
      available -= amountCents;
    }
  }

  for (const component of input.components) {
    if (component.kind !== "deduction") continue;
    if (duplicates.some((pattern) => pattern.test(component.name))) continue;
    const wanted = cents(
      component.calc === "percent_basic" ? (basePay * component.value) / 100 : component.value,
    );
    const amountCents = Math.min(wanted, available);
    if (amountCents <= 0) continue;
    deductionLines.push({ name: component.name, kind: "deduction", amountCents });
    available -= amountCents;
  }
  const componentDeductionsCents = deductionLines.reduce((sum, line) => sum + line.amountCents, 0);

  const loanLines: CalcResult["loanLines"] = [];
  for (const loan of settings.autoDeductLoans ? input.loans : []) {
    const amountCents = Math.min(loan.installmentCents, loan.outstandingCents, available);
    if (amountCents <= 0) continue;
    loanLines.push({ recoverableId: loan.recoverableId, label: loan.label, amountCents });
    available -= amountCents;
  }
  const loanDeductionCents = loanLines.reduce((sum, line) => sum + line.amountCents, 0);
  const totalDeductionsCents = fineCents + componentDeductionsCents + loanDeductionCents;

  return {
    workingDays,
    presentDays: present,
    halfDays: half,
    paidLeaveDays: paidLeave,
    unpaidLeaveDays: unpaidLeave,
    absentDays: absent,
    incompleteDays: incomplete,
    workedMinutes,
    overtimeMinutes,
    lateCount,
    lateMinutes,
    basePayCents,
    overtimePayCents,
    allowancesPayCents,
    bonusPayCents,
    offDayDays: offDayWork.reduce((total, work) => total + work.days, 0),
    offDayPayCents,
    offDayPending,
    grossPayCents,
    lateFineCents: fineCents,
    componentDeductionsCents,
    componentLines: [...earningLines, ...deductionLines],
    loanLines,
    loanDeductionCents,
    totalDeductionsCents,
    netPayCents: grossPayCents - totalDeductionsCents,
    statutory: breakup,
  };
};

/** What the employee would earn for a full month, used to decide ESI eligibility. */
const fullMonthEntitlement = (input: {
  type: CompensationType;
  amount: number;
  workingDays: number;
  hoursPerDay: number;
  components: SalaryComponent[];
}) => {
  const base =
    input.type === "fixed_salary"
      ? input.amount
      : input.type === "daily"
        ? input.amount * input.workingDays
        : input.amount * input.hoursPerDay * input.workingDays;
  const allowances = input.components
    .filter((component) => component.kind === "earning")
    .reduce(
      (sum, component) =>
        sum + (component.calc === "percent_basic" ? (base * component.value) / 100 : component.value),
      0,
    );
  return base + allowances;
};
