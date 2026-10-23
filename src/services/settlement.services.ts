import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  employeeExitsTable as exits,
  employeeRecoverableRepaymentsTable as repayments,
  employeeRecoverablesTable as recoverables,
  finalSettlementsTable as settlements,
  organizationPayrollSettingsTable,
  organizationsTable,
  payrollItemsTable,
  payrollRunsTable,
  userOrganizationsTable as memberships,
  usersTable,
  type CompensationType,
  type SettlementInputs,
  type SettlementLine,
} from "@/drizzle/schema";
import { MANAGER_ROLES, requireRole } from "@/services/access.services";
import { assetsHeldBy } from "@/services/asset.services";
import { getOrganizationFeatures } from "@/services/billing-access.services";
import { settleBonusesInPayroll } from "@/services/bonus.services";
import { CATEGORY_LABELS, loadUnpaidClaims, settleClaimsInSettlement } from "@/services/expense.services";
import { remainingPaidLeave } from "@/services/leave.services";
import { notify } from "@/services/notification.services";
import { buildPayrollItems } from "@/services/payroll.services";
import { fromCents, lockAndMeasure, toCents, totalDueCents } from "@/services/recoverable.services";
import { defaultDailyRate, gratuity, monthlyBasicOf, noticeShortfallDays, settlementTotals } from "@/services/settlement-calc";
import { fail, ok } from "@/utils/result";
import type { markSettlementPaidSchema, settlementInputsSchema } from "@/validator/settlement.validator";

/**
 * Full & final settlement for a leaver. Prepared from the employee's exit record by owners and admins
 * (who run payroll): every line is worked out from the inputs and saved as a draft; finalizing records
 * the loan recoveries and pays the expense claims; then it is marked paid. Payroll runs skip the
 * employee from the settlement's salary start date onward.
 */

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const loadContext = async (organizationId: string, employeeId: string) => {
  const [person] = await db
    .select({
      membershipId: memberships.id,
      employeeId: memberships.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      employeeCode: memberships.employeeCode,
      jobTitle: memberships.jobTitle,
      hireDate: memberships.hireDate,
      compensationType: memberships.compensationType,
      compensationAmount: memberships.compensationAmount,
      compensationCurrency: memberships.compensationCurrency,
      salaryComponents: memberships.salaryComponents,
    })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, employeeId)))
    .limit(1);
  if (!person) return null;
  const [exit] = await db
    .select()
    .from(exits)
    .where(and(eq(exits.organizationId, organizationId), eq(exits.userId, employeeId)))
    .limit(1);
  const [settings] = await db
    .select({ currencyCode: organizationPayrollSettingsTable.currencyCode })
    .from(organizationPayrollSettingsTable)
    .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
    .limit(1);
  return {
    ...person,
    employeeName: `${person.fname} ${person.lname}`.trim(),
    compensationAmount: person.compensationAmount === null ? 0 : Number(person.compensationAmount),
    exit: exit && exit.status !== "cancelled" ? exit : null,
    currencyCode: person.compensationCurrency ?? settings?.currencyCode ?? "INR",
  };
};

type Context = NonNullable<Awaited<ReturnType<typeof loadContext>>>;

const monthlyBasic = (ctx: Context) =>
  monthlyBasicOf({ compensationType: ctx.compensationType as CompensationType | null, compensationAmount: ctx.compensationAmount });

/** The day after the last finalized payroll period that paid this employee, else the start of the leaving month. */
const defaultSalaryFrom = async (organizationId: string, ctx: Context, lastWorkingDay: string) => {
  const [lastPaid] = await db
    .select({ periodEnd: payrollRunsTable.periodEnd })
    .from(payrollItemsTable)
    .innerJoin(payrollRunsTable, eq(payrollRunsTable.id, payrollItemsTable.runId))
    .where(
      and(
        eq(payrollItemsTable.organizationId, organizationId),
        eq(payrollItemsTable.userOrganizationId, ctx.membershipId),
        eq(payrollRunsTable.status, "finalized"),
      ),
    )
    .orderBy(desc(payrollRunsTable.periodEnd))
    .limit(1);
  const monthStart = `${lastWorkingDay.slice(0, 8)}01`;
  const candidate = lastPaid ? addDays(lastPaid.periodEnd, 1) : monthStart;
  return ctx.hireDate && ctx.hireDate > candidate ? ctx.hireDate : candidate;
};

const suggest = async (organizationId: string, ctx: Context, lastWorkingDay: string) => {
  const leave = await remainingPaidLeave(organizationId, ctx.membershipId, lastWorkingDay);
  const gratuityInfo = gratuity({ hireDate: ctx.hireDate, lastWorkingDay, monthlyBasic: monthlyBasic(ctx) });
  const inputs: SettlementInputs = {
    salaryFrom: await defaultSalaryFrom(organizationId, ctx, lastWorkingDay),
    encashDays: leave.reduce((sum, item) => sum + item.remainingDays, 0),
    dailyRate: defaultDailyRate({ compensationType: ctx.compensationType as CompensationType | null, compensationAmount: ctx.compensationAmount }),
    includeGratuity: gratuityInfo.eligible,
    waiveNoticeRecovery: false,
    extraLines: [],
    utcOffsetMinutes: 330,
  };
  return { inputs, leave, gratuity: gratuityInfo };
};

/** Every line of the settlement from the inputs. */
const computeLines = async (organizationId: string, ctx: Context, lastWorkingDay: string, inputs: SettlementInputs) => {
  const lines: SettlementLine[] = [];
  const notes: string[] = [];
  let statutory = null;
  // Gratuity, loan recovery and claim reimbursement only when the plan includes them.
  const features = new Set(await getOrganizationFeatures(organizationId));

  if (inputs.salaryFrom <= lastWorkingDay) {
    const built = await buildPayrollItems(
      organizationId,
      { periodStart: inputs.salaryFrom, periodEnd: lastWorkingDay, utcOffsetMinutes: inputs.utcOffsetMinutes },
      { membershipIds: [ctx.membershipId], includeInactive: true, recoverLoans: false, reimburseClaims: false, payBonuses: true },
    );
    const item = built.values[0];
    if (item) {
      // An approved bonus not yet paid goes out with the final salary, taxed with it.
      const bonus = Number(item.bonus) > 0 ? `, incl. bonus ${item.bonus}` : "";
      lines.push({
        kind: "salary",
        label: `Salary ${inputs.salaryFrom} to ${lastWorkingDay}${bonus} (after PF, ESI, PT, TDS)`,
        amount: item.netPay,
        ...(item.bonusLines.length ? { bonusItemIds: item.bonusLines.map((line) => line.bonusItemId) } : {}),
      });
      statutory = item.statutory;
    } else {
      notes.push("Final salary not calculated: set the employee's pay first.");
    }
  }

  if (inputs.encashDays > 0 && inputs.dailyRate > 0) {
    lines.push({ kind: "leave_encashment", label: `Leave encashment: ${inputs.encashDays} days × ${inputs.dailyRate}`, amount: fromCents(toCents(inputs.encashDays * inputs.dailyRate)) });
  }

  const gratuityInfo = gratuity({ hireDate: ctx.hireDate, lastWorkingDay, monthlyBasic: monthlyBasic(ctx) });
  if (features.has("bonus") && inputs.includeGratuity && gratuityInfo.eligible) {
    lines.push({ kind: "gratuity", label: `Gratuity: ${gratuityInfo.reason}`, amount: gratuityInfo.amount.toFixed(2) });
  }

  if (ctx.exit?.exitType === "resignation" && !inputs.waiveNoticeRecovery) {
    const shortfall = noticeShortfallDays({ resignationDate: ctx.exit.resignationDate, noticeDays: ctx.exit.noticeDays, lastWorkingDay });
    if (shortfall > 0 && inputs.dailyRate > 0) {
      lines.push({ kind: "notice_recovery", label: `Notice not served: ${shortfall} days × ${inputs.dailyRate}`, amount: fromCents(toCents(shortfall * inputs.dailyRate)) });
    }
  }

  // Outstanding loans and advances are recovered in full.
  const loans = features.has("loans")
    ? await db
        .select()
        .from(recoverables)
        .where(and(eq(recoverables.organizationId, organizationId), eq(recoverables.userOrganizationId, ctx.membershipId), inArray(recoverables.status, ["disbursed", "active"])))
    : [];
  if (loans.length) {
    const paid = await db
      .select({ recoverableId: repayments.recoverableId, amount: repayments.amount })
      .from(repayments)
      .where(and(inArray(repayments.recoverableId, loans.map((loan) => loan.id)), eq(repayments.status, "confirmed")));
    for (const loan of loans) {
      const outstanding = totalDueCents(loan) - paid.filter((p) => p.recoverableId === loan.id).reduce((sum, p) => sum + toCents(p.amount), 0);
      if (outstanding > 0) {
        lines.push({ kind: "loan_recovery", label: `${loan.type === "loan" ? "Loan" : "Salary advance"} outstanding${loan.description ? `: ${loan.description}` : ""}`, amount: fromCents(outstanding), recoverableId: loan.id });
      }
    }
  }

  for (const claim of features.has("expenses") ? await loadUnpaidClaims(organizationId, ctx.membershipId) : []) {
    lines.push({ kind: "reimbursement", label: `Expense claim: ${CATEGORY_LABELS[claim.category]} (${claim.expenseDate})`, amount: Number(claim.amount).toFixed(2), claimId: claim.id });
  }

  for (const extra of inputs.extraLines) {
    lines.push({ kind: extra.kind, label: extra.label, amount: extra.amount.toFixed(2) });
  }
  return { lines, statutory, notes, gratuity: gratuityInfo };
};

const currentSettlement = async (membershipId: string) => {
  const [row] = await db
    .select()
    .from(settlements)
    .where(and(eq(settlements.userOrganizationId, membershipId), ne(settlements.status, "cancelled")))
    .orderBy(desc(settlements.createdAt))
    .limit(1);
  return row ?? null;
};

/** The employee's exit, any settlement, and a suggested draft when none exists yet. */
export const getSettlement = async (organizationId: string, requesterId: string, employeeId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const ctx = await loadContext(organizationId, employeeId);
  if (!ctx) return fail("not-found", "Employee not found");
  const exit = ctx.exit;
  const settlement = exit ? await currentSettlement(ctx.membershipId) : null;
  const suggestion = exit ? await suggest(organizationId, ctx, exit.lastWorkingDay) : null;
  // A suggested draft, shown until the first one is saved.
  const preview =
    exit && suggestion && !settlement
      ? await computeLines(organizationId, ctx, exit.lastWorkingDay, suggestion.inputs).then((computed) => ({
          inputs: suggestion.inputs,
          ...computed,
          ...settlementTotals(computed.lines),
        }))
      : null;
  // Company property not returned yet: recover it before paying, or add a deduction line for it.
  const assetsHeld = exit ? await assetsHeldBy(ctx.membershipId) : [];
  return ok({
    employeeName: ctx.employeeName,
    exit,
    assetsHeld,
    currencyCode: ctx.currencyCode,
    leaveBalances: suggestion?.leave ?? [],
    gratuity: suggestion?.gratuity ?? null,
    settlement,
    preview,
  });
};

/** Saves (or replaces) the draft, working out every line again from the inputs. */
export const saveSettlementDraft = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  input: z.infer<typeof settlementInputsSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const ctx = await loadContext(organizationId, employeeId);
  if (!ctx?.exit) return fail("conflict", "Record the employee's exit first");
  if (input.salaryFrom > addDays(ctx.exit.lastWorkingDay, 1)) return fail("invalid", "The salary start date is after the last working day");
  const existing = await currentSettlement(ctx.membershipId);
  if (existing && existing.status !== "draft") return fail("conflict", "This settlement is already finalized");

  const computed = await computeLines(organizationId, ctx, ctx.exit.lastWorkingDay, input);
  const totals = settlementTotals(computed.lines);
  const values = {
    lastWorkingDay: ctx.exit.lastWorkingDay,
    salaryFrom: input.salaryFrom,
    currencyCode: ctx.currencyCode,
    inputs: input,
    lines: computed.lines,
    statutory: computed.statutory,
    ...totals,
    notes: computed.notes.join(" ") || null,
    preparedByUserId: requesterId,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(settlements).set(values).where(eq(settlements.id, existing.id));
  } else {
    await db.insert(settlements).values({ organizationId, userOrganizationId: ctx.membershipId, ...values });
  }
  return getSettlement(organizationId, requesterId, employeeId);
};

/** Raised inside the finalize transaction so nothing it wrote is kept. */
class SettlementConflict extends Error {}

/** Locks the settlement: records each loan recovery as a repayment and marks the expense claims paid. */
export const finalizeSettlement = async (organizationId: string, requesterId: string, employeeId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const ctx = await loadContext(organizationId, employeeId);
  if (!ctx) return fail("not-found", "Employee not found");
  const settlement = await currentSettlement(ctx.membershipId);
  if (!settlement || settlement.status !== "draft") return fail("conflict", "There is no draft settlement to finalize");

  try {
    await db.transaction(async (tx) => {
      for (const line of settlement.lines.filter((item) => item.kind === "loan_recovery" && item.recoverableId)) {
        const locked = await lockAndMeasure(tx, organizationId, line.recoverableId!);
        const amount = toCents(line.amount);
        if (!locked.ok || amount > locked.data.outstanding) {
          throw new SettlementConflict("A loan balance changed since the draft was saved. Save the draft again and retry");
        }
        await tx.insert(repayments).values({
          organizationId,
          recoverableId: line.recoverableId!,
          amount: line.amount,
          currencyCode: settlement.currencyCode,
          source: "manual",
          status: "confirmed",
          notes: "Recovered in full & final settlement",
          submittedByUserId: requesterId,
          reviewedByUserId: requesterId,
          reviewedAt: new Date(),
        });
        await tx
          .update(recoverables)
          .set({ status: amount === locked.data.outstanding ? "completed" : "active", updatedAt: new Date() })
          .where(eq(recoverables.id, line.recoverableId!));
      }
      const claimIds = settlement.lines.flatMap((line) => (line.claimId ? [line.claimId] : []));
      if (!(await settleClaimsInSettlement(tx, organizationId, claimIds))) {
        throw new SettlementConflict("An expense claim changed since the draft was saved. Save the draft again and retry");
      }
      const bonusItemIds = settlement.lines.flatMap((line) => line.bonusItemIds ?? []);
      if (!(await settleBonusesInPayroll(tx, organizationId, null, bonusItemIds))) {
        throw new SettlementConflict("A bonus was paid since the draft was saved. Save the draft again and retry");
      }
      const [updated] = await tx
        .update(settlements)
        .set({ status: "finalized", finalizedByUserId: requesterId, finalizedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(settlements.id, settlement.id), eq(settlements.status, "draft")))
        .returning({ id: settlements.id });
      if (!updated) throw new SettlementConflict("This settlement was finalized by someone else");
    });
  } catch (error) {
    if (error instanceof SettlementConflict) return fail("conflict", error.message);
    throw error;
  }
  await notify({
    organizationId,
    userIds: [ctx.employeeId],
    type: "settlement_finalized",
    title: "Your full & final settlement is ready",
    body: `Net ${settlement.currencyCode} ${settlement.netPayable}`,
    link: "/profile",
  });
  return getSettlement(organizationId, requesterId, employeeId);
};

export const markSettlementPaid = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  input: z.infer<typeof markSettlementPaidSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const ctx = await loadContext(organizationId, employeeId);
  if (!ctx) return fail("not-found", "Employee not found");
  const settlement = await currentSettlement(ctx.membershipId);
  if (!settlement || settlement.status !== "finalized") return fail("conflict", "Only a finalized settlement can be marked paid");
  await db
    .update(settlements)
    .set({
      status: "paid",
      paidAt: input.paidOn ? new Date(`${input.paidOn}T12:00:00+05:30`) : new Date(),
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference || null,
      updatedAt: new Date(),
    })
    .where(eq(settlements.id, settlement.id));
  return getSettlement(organizationId, requesterId, employeeId);
};

/** Throws away a draft; a finalized settlement has already moved money and cannot be cancelled. */
export const cancelSettlementDraft = async (organizationId: string, requesterId: string, employeeId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const ctx = await loadContext(organizationId, employeeId);
  if (!ctx) return fail("not-found", "Employee not found");
  const settlement = await currentSettlement(ctx.membershipId);
  if (!settlement || settlement.status !== "draft") return fail("conflict", "Only a draft can be discarded");
  await db.update(settlements).set({ status: "cancelled", updatedAt: new Date() }).where(eq(settlements.id, settlement.id));
  return getSettlement(organizationId, requesterId, employeeId);
};

/** All settlements, for the overview of leavers. */
export const listSettlements = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const [pending, rows] = await Promise.all([
    // Exits without a settlement yet.
    db
      .select({ employeeId: exits.userId, fname: usersTable.fname, lname: usersTable.lname, lastWorkingDay: exits.lastWorkingDay, exitStatus: exits.status, membershipId: memberships.id })
      .from(exits)
      .innerJoin(usersTable, eq(usersTable.id, exits.userId))
      .innerJoin(memberships, and(eq(memberships.userId, exits.userId), eq(memberships.organizationId, exits.organizationId)))
      .where(and(eq(exits.organizationId, organizationId), ne(exits.status, "cancelled"))),
    db
      .select({
        membershipId: settlements.userOrganizationId,
        status: settlements.status,
        netPayable: settlements.netPayable,
        currencyCode: settlements.currencyCode,
        updatedAt: settlements.updatedAt,
      })
      .from(settlements)
      .where(and(eq(settlements.organizationId, organizationId), ne(settlements.status, "cancelled"))),
  ]);
  return ok(
    pending
      .map((exit) => {
        const settlement = rows.find((row) => row.membershipId === exit.membershipId);
        return {
          employeeId: exit.employeeId,
          employeeName: `${exit.fname} ${exit.lname}`.trim(),
          lastWorkingDay: exit.lastWorkingDay,
          exitStatus: exit.exitStatus,
          settlementStatus: settlement?.status ?? null,
          netPayable: settlement?.netPayable ?? null,
          currencyCode: settlement?.currencyCode ?? null,
        };
      })
      .sort((a, b) => b.lastWorkingDay.localeCompare(a.lastWorkingDay)),
  );
};

/** Data for the settlement statement PDF. */
export const loadSettlementStatement = async (organizationId: string, requesterId: string, employeeId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const ctx = await loadContext(organizationId, employeeId);
  if (!ctx?.exit) return fail("not-found", "No settlement found");
  const settlement = await currentSettlement(ctx.membershipId);
  if (!settlement) return fail("not-found", "No settlement found");
  const [organization] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
  return ok({ organizationName: organization?.name ?? "", employee: ctx, exit: ctx.exit, settlement });
};

export type SettlementStatement = Extract<Awaited<ReturnType<typeof loadSettlementStatement>>, { ok: true }>["data"];
