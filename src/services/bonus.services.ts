import { and, asc, desc, eq, inArray, isNull, gt, gte, lte, ne, or } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  bonusItemsTable as bonusItems,
  bonusRunsTable as bonusRuns,
  organizationPayrollSettingsTable,
  payrollItemsTable,
  payrollRunsTable,
  userOrganizationsTable as memberships,
  usersTable,
  departmentsTable,
  UserRole,
  type CompensationType,
} from "@/drizzle/schema";
import { MANAGER_ROLES, requireRole } from "@/services/access.services";
import { requireFullAccess } from "@/services/billing-access.services";
import { computeBonus, isDearnessAllowance, type BonusMonth } from "@/services/bonus-calc";
import { notify } from "@/services/notification.services";
import { fromCents, toCents } from "@/services/recoverable.services";
import { accruedGratuity, monthlyBasicOf } from "@/services/settlement-calc";
import { financialYearOf } from "@/services/statutory-calc";
import { fail, ok } from "@/utils/result";
import type { calculateBonusSchema, markBonusPaidSchema, updateBonusItemSchema } from "@/validator/bonus.validator";

/**
 * Statutory bonus runs, one per financial year, and the gratuity liability report. Owners and admins
 * only, like payroll. A run is calculated from finalized payroll, adjusted, approved, then paid either
 * with the next payroll (as a taxable earning) or directly, outside payroll.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const fyRange = (label: string) => {
  const start = Number(label.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
};

const loadRun = async (organizationId: string, runId: string) => {
  const [run] = await db
    .select()
    .from(bonusRuns)
    .where(and(eq(bonusRuns.organizationId, organizationId), eq(bonusRuns.id, runId)))
    .limit(1);
  return run ?? null;
};

const currencyOf = async (organizationId: string) => {
  const [settings] = await db
    .select({ currencyCode: organizationPayrollSettingsTable.currencyCode })
    .from(organizationPayrollSettingsTable)
    .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
    .limit(1);
  return settings?.currencyCode ?? "INR";
};

const runDetail = async (organizationId: string, runId: string) => {
  const run = await loadRun(organizationId, runId);
  if (!run) return fail("not-found", "Bonus run not found");
  const items = await db
    .select()
    .from(bonusItems)
    .where(eq(bonusItems.runId, runId))
    .orderBy(desc(bonusItems.eligible), asc(bonusItems.employeeName));
  // Finalized payroll months the run was worked out from, so the screen can say how complete it is.
  const range = fyRange(run.financialYear);
  const months = await db
    .selectDistinct({ periodEnd: payrollRunsTable.periodEnd })
    .from(payrollRunsTable)
    .where(and(eq(payrollRunsTable.organizationId, organizationId), eq(payrollRunsTable.status, "finalized"), gte(payrollRunsTable.periodEnd, range.from), lte(payrollRunsTable.periodEnd, range.to)));
  return ok({ run, items, currencyCode: await currencyOf(organizationId), payrollMonths: new Set(months.map((m) => m.periodEnd.slice(0, 7))).size });
};

export const listBonusRuns = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const runs = await db
    .select()
    .from(bonusRuns)
    .where(eq(bonusRuns.organizationId, organizationId))
    .orderBy(desc(bonusRuns.financialYear));
  return ok({ runs, currentFinancialYear: financialYearOf(new Date().toISOString().slice(0, 10)).label, currencyCode: await currencyOf(organizationId) });
};

export const getBonusRun = async (organizationId: string, requesterId: string, runId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  return runDetail(organizationId, runId);
};

/** Each employee's months of the year from finalized payroll: basic + DA earned, and days worked. */
const loadBonusMonths = async (organizationId: string, financialYear: string) => {
  const range = fyRange(financialYear);
  const rows = await db
    .select({
      membershipId: payrollItemsTable.userOrganizationId,
      employeeName: payrollItemsTable.employeeName,
      periodEnd: payrollRunsTable.periodEnd,
      basePay: payrollItemsTable.basePay,
      componentLines: payrollItemsTable.componentLines,
      presentDays: payrollItemsTable.presentDays,
      halfDays: payrollItemsTable.halfDays,
      paidLeaveDays: payrollItemsTable.paidLeaveDays,
    })
    .from(payrollItemsTable)
    .innerJoin(payrollRunsTable, eq(payrollRunsTable.id, payrollItemsTable.runId))
    .where(
      and(
        eq(payrollItemsTable.organizationId, organizationId),
        eq(payrollRunsTable.status, "finalized"),
        gte(payrollRunsTable.periodEnd, range.from),
        lte(payrollRunsTable.periodEnd, range.to),
      ),
    );
  const byEmployee = new Map<string, { employeeName: string; months: Map<string, BonusMonth> }>();
  for (const row of rows) {
    const entry = byEmployee.get(row.membershipId) ?? { employeeName: row.employeeName, months: new Map() };
    const key = row.periodEnd.slice(0, 7);
    const month = entry.months.get(key) ?? { month: key, wage: 0, days: 0 };
    const da = row.componentLines
      .filter((line) => line.kind === "earning" && isDearnessAllowance(line.name))
      .reduce((sum, line) => sum + Number(line.amount), 0);
    // Runs shorter than a month (weekly payroll) add up into their month, so the monthly cap applies to the month.
    month.wage += Number(row.basePay) + da;
    month.days += Number(row.presentDays) + Number(row.halfDays) * 0.5 + Number(row.paidLeaveDays);
    entry.months.set(key, month);
    entry.employeeName = row.employeeName;
    byEmployee.set(row.membershipId, entry);
  }
  return byEmployee;
};

/** Creates the year's run, or works a draft out again (adjustments are reset). */
export const calculateBonusRun = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof calculateBonusSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return billing;

  const [existing] = await db
    .select()
    .from(bonusRuns)
    .where(and(eq(bonusRuns.organizationId, organizationId), eq(bonusRuns.financialYear, input.financialYear)))
    .limit(1);
  if (existing && existing.status !== "draft") return fail("conflict", "This year's bonus is already approved");

  const months = await loadBonusMonths(organizationId, input.financialYear);
  if (months.size === 0) return fail("invalid", "There is no finalized payroll in this financial year to work the bonus out from");

  const rules = { percentage: input.percentage, eligibilityCeiling: input.eligibilityCeiling, calculationCeiling: input.calculationCeiling };
  const lines = [...months].map(([membershipId, entry]) => {
    const result = computeBonus([...entry.months.values()], rules);
    return {
      organizationId,
      userOrganizationId: membershipId,
      employeeName: entry.employeeName,
      eligible: result.eligible,
      reason: result.reason,
      monthlyWage: result.monthlyWage.toFixed(2),
      daysWorked: result.daysWorked.toFixed(1),
      bonusWages: result.bonusWages.toFixed(2),
      calculatedAmount: result.amount.toFixed(2),
      finalAmount: result.amount.toFixed(2),
      included: result.eligible,
    };
  });
  const total = lines.filter((line) => line.included).reduce((sum, line) => sum + toCents(line.finalAmount), 0);
  const runValues = {
    percentage: input.percentage.toFixed(2),
    eligibilityCeiling: input.eligibilityCeiling.toFixed(2),
    calculationCeiling: input.calculationCeiling.toFixed(2),
    payout: input.payout,
    totalAmount: fromCents(total),
    updatedAt: new Date(),
  };

  const runId = await db.transaction(async (tx) => {
    let id = existing?.id;
    if (id) {
      await tx.update(bonusRuns).set(runValues).where(and(eq(bonusRuns.id, id), eq(bonusRuns.status, "draft")));
      await tx.delete(bonusItems).where(eq(bonusItems.runId, id));
    } else {
      const [created] = await tx
        .insert(bonusRuns)
        .values({ organizationId, financialYear: input.financialYear, createdByUserId: requesterId, ...runValues })
        .returning({ id: bonusRuns.id });
      id = created.id;
    }
    await tx.insert(bonusItems).values(lines.map((line) => ({ ...line, runId: id! })));
    return id;
  });
  return runDetail(organizationId, runId);
};

const refreshTotal = async (runId: string) => {
  const rows = await db
    .select({ amount: bonusItems.finalAmount })
    .from(bonusItems)
    .where(and(eq(bonusItems.runId, runId), eq(bonusItems.included, true)));
  const total = rows.reduce((sum, row) => sum + toCents(row.amount), 0);
  await db.update(bonusRuns).set({ totalAmount: fromCents(total), updatedAt: new Date() }).where(eq(bonusRuns.id, runId));
};

/** Adjusts one employee's amount, or leaves them out, while the run is a draft. */
export const updateBonusItem = async (
  organizationId: string,
  requesterId: string,
  runId: string,
  itemId: string,
  input: z.infer<typeof updateBonusItemSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const run = await loadRun(organizationId, runId);
  if (!run) return fail("not-found", "Bonus run not found");
  if (run.status !== "draft") return fail("conflict", "An approved bonus cannot be changed");
  const [updated] = await db
    .update(bonusItems)
    .set({
      ...(input.finalAmount !== undefined ? { finalAmount: input.finalAmount.toFixed(2) } : {}),
      ...(input.included !== undefined ? { included: input.included } : {}),
    })
    .where(and(eq(bonusItems.runId, runId), eq(bonusItems.id, itemId)))
    .returning({ id: bonusItems.id });
  if (!updated) return fail("not-found", "Employee not found in this bonus run");
  await refreshTotal(runId);
  return runDetail(organizationId, runId);
};

export const deleteBonusRun = async (organizationId: string, requesterId: string, runId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const run = await loadRun(organizationId, runId);
  if (!run) return fail("not-found", "Bonus run not found");
  if (run.status !== "draft") return fail("conflict", "Only a draft can be deleted");
  await db.delete(bonusRuns).where(and(eq(bonusRuns.id, runId), eq(bonusRuns.status, "draft")));
  return ok(null);
};

/** Locks the amounts. Paid with payroll: the next payroll run generated picks them up. */
export const approveBonusRun = async (organizationId: string, requesterId: string, runId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return billing;
  const run = await loadRun(organizationId, runId);
  if (!run) return fail("not-found", "Bonus run not found");
  if (run.status !== "draft") return fail("conflict", "This bonus is already approved");
  const [approved] = await db
    .update(bonusRuns)
    .set({ status: "approved", approvedByUserId: requesterId, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(bonusRuns.id, runId), eq(bonusRuns.status, "draft")))
    .returning({ id: bonusRuns.id });
  if (!approved) return fail("conflict", "This bonus was approved by someone else");

  const recipients = await db
    .select({ userId: memberships.userId, amount: bonusItems.finalAmount })
    .from(bonusItems)
    .innerJoin(memberships, eq(memberships.id, bonusItems.userOrganizationId))
    .where(and(eq(bonusItems.runId, runId), eq(bonusItems.included, true), gt(bonusItems.finalAmount, "0")));
  const currency = await currencyOf(organizationId);
  for (const recipient of recipients) {
    await notify({
      organizationId,
      userIds: [recipient.userId],
      type: "bonus_approved",
      title: `Your bonus for ${run.financialYear} is approved`,
      body: `${currency} ${recipient.amount}${run.payout === "payroll" ? ", paid with your next salary" : ""}`,
      link: "/salary-slips",
    });
  }
  return runDetail(organizationId, runId);
};

/** Paid outside payroll (bank transfer, cheque): records the payment for every included employee. */
export const markBonusPaid = async (
  organizationId: string,
  requesterId: string,
  runId: string,
  input: z.infer<typeof markBonusPaidSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const run = await loadRun(organizationId, runId);
  if (!run) return fail("not-found", "Bonus run not found");
  if (run.status !== "approved") return fail("conflict", "Only an approved bonus can be marked paid");
  // Some may already have gone out with a payroll before switching; those keep their payroll record.
  const paidAt = input.paidOn ? new Date(`${input.paidOn}T12:00:00+05:30`) : new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(bonusItems)
      .set({ paidAt })
      .where(and(eq(bonusItems.runId, runId), eq(bonusItems.included, true), isNull(bonusItems.paidAt)));
    await tx
      .update(bonusRuns)
      .set({ status: "paid", payout: "direct", paidAt, paymentReference: input.paymentReference || null, updatedAt: new Date() })
      .where(eq(bonusRuns.id, runId));
  });
  return runDetail(organizationId, runId);
};

export type PayrollBonusLine = { bonusItemId: string; label: string; amount: string };

/** Approved bonuses waiting for a payroll, by employee (membership id). */
export const loadPayrollBonuses = async (organizationId: string) => {
  const rows = await db
    .select({ id: bonusItems.id, membershipId: bonusItems.userOrganizationId, amount: bonusItems.finalAmount, financialYear: bonusRuns.financialYear })
    .from(bonusItems)
    .innerJoin(bonusRuns, eq(bonusRuns.id, bonusItems.runId))
    .where(
      and(
        eq(bonusItems.organizationId, organizationId),
        eq(bonusRuns.status, "approved"),
        eq(bonusRuns.payout, "payroll"),
        eq(bonusItems.included, true),
        gt(bonusItems.finalAmount, "0"),
        isNull(bonusItems.paidAt),
      ),
    );
  const byMembership = new Map<string, PayrollBonusLine[]>();
  for (const row of rows) {
    const lines = byMembership.get(row.membershipId) ?? [];
    lines.push({ bonusItemId: row.id, label: `Bonus ${row.financialYear}`, amount: Number(row.amount).toFixed(2) });
    byMembership.set(row.membershipId, lines);
  }
  return byMembership;
};

/**
 * Inside the payroll (or final settlement, with no run id) finalize transaction: marks the bonuses paid. False when one was paid
 * elsewhere since the payroll was generated, so the caller rolls back. A run whose bonuses are all paid becomes paid.
 */
export const settleBonusesInPayroll = async (tx: Tx, organizationId: string, payrollRunId: string | null, itemIds: string[]) => {
  if (itemIds.length === 0) return true;
  const paidAt = new Date();
  const updated = await tx
    .update(bonusItems)
    .set({ paidAt, paidInPayrollRunId: payrollRunId })
    .where(and(eq(bonusItems.organizationId, organizationId), inArray(bonusItems.id, itemIds), isNull(bonusItems.paidAt)))
    .returning({ runId: bonusItems.runId });
  if (updated.length !== itemIds.length) return false;
  for (const runId of new Set(updated.map((row) => row.runId))) {
    const [unpaid] = await tx
      .select({ id: bonusItems.id })
      .from(bonusItems)
      .where(and(eq(bonusItems.runId, runId), eq(bonusItems.included, true), gt(bonusItems.finalAmount, "0"), isNull(bonusItems.paidAt)))
      .limit(1);
    if (!unpaid) {
      await tx.update(bonusRuns).set({ status: "paid", paidAt, updatedAt: paidAt }).where(and(eq(bonusRuns.id, runId), eq(bonusRuns.status, "approved")));
    }
  }
  return true;
};

/**
 * Gratuity every active employee has earned up to a date: service, whether it is payable yet, and the
 * amount at today's basic. The total is the liability the company carries.
 */
export const gratuityLiability = async (organizationId: string, requesterId: string, asOf: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const rows = await db
    .select({
      employeeId: memberships.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      employeeCode: memberships.employeeCode,
      departmentName: departmentsTable.name,
      hireDate: memberships.hireDate,
      compensationType: memberships.compensationType,
      compensationAmount: memberships.compensationAmount,
    })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .leftJoin(departmentsTable, eq(departmentsTable.id, memberships.departmentId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.isActive, true),
        or(ne(memberships.role, UserRole.SUPER_ADMIN), eq(memberships.includeInPayroll, true)),
      ),
    );

  const soon = new Date(Date.parse(`${asOf}T00:00:00Z`));
  soon.setUTCMonth(soon.getUTCMonth() + 6);
  const sixMonths = soon.toISOString().slice(0, 10);

  const employees = rows
    .map((row) => {
      const base = {
        employeeId: row.employeeId,
        employeeName: `${row.fname} ${row.lname}`.trim(),
        employeeCode: row.employeeCode,
        departmentName: row.departmentName,
        hireDate: row.hireDate,
      };
      const monthlyBasic = monthlyBasicOf({
        compensationType: row.compensationType as CompensationType | null,
        compensationAmount: row.compensationAmount === null ? 0 : Number(row.compensationAmount),
      });
      if (!row.hireDate || row.hireDate > asOf) {
        return { ...base, monthlyBasic, serviceYears: 0, serviceMonths: 0, countedYears: 0, eligible: false, eligibleFrom: null, eligibleSoon: false, amount: 0, note: row.hireDate ? "Joins after this date" : "No hire date on record" };
      }
      const accrued = accruedGratuity({ hireDate: row.hireDate, asOf, monthlyBasic });
      return {
        ...base,
        monthlyBasic,
        serviceYears: accrued.service.years,
        serviceMonths: accrued.service.months,
        countedYears: accrued.years,
        eligible: accrued.eligible,
        eligibleFrom: accrued.eligibleFrom,
        eligibleSoon: !accrued.eligible && accrued.eligibleFrom <= sixMonths,
        amount: accrued.amount,
        note: monthlyBasic > 0 ? null : "No pay on record",
      };
    })
    .sort((a, b) => b.amount - a.amount || a.employeeName.localeCompare(b.employeeName));

  const sum = (list: typeof employees) => list.reduce((total, e) => total + e.amount, 0);
  return ok({
    asOf,
    currencyCode: await currencyOf(organizationId),
    totalLiability: sum(employees),
    payableNow: sum(employees.filter((e) => e.eligible)),
    eligibleCount: employees.filter((e) => e.eligible).length,
    eligibleSoonCount: employees.filter((e) => e.eligibleSoon).length,
    employees,
  });
};
