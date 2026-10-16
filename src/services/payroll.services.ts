import { and, desc, eq, gte, inArray, lte, ne, or } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  branchesTable,
  departmentsTable,
  employeeRecoverableRepaymentsTable as repayments,
  finalSettlementsTable,
  employeeRecoverablesTable as recoverables,
  leaveRequestsTable,
  leaveTypesTable,
  organizationPayrollSettingsTable,
  organizationsTable,
  overtimeApprovalsTable,
  payrollItemsTable as items,
  payrollRunsTable as runs,
  shiftsTable,
  userOrganizationsTable as memberships,
  UserRole,
  usersTable,
} from "@/drizzle/schema";
import { ALL_ROLES, isOrganizationManager, MANAGER_ROLES, requireRole } from "@/services/access.services";
import { computeDailyAttendance } from "@/services/attendance.services";
import { notify } from "@/services/notification.services";
import { queueDelivery, sendableChannels } from "@/services/messaging.services";
import { maskEmail, maskPhone } from "@/services/messaging-template";
import { deliveryChannels } from "@/services/user.services";
import { requireFullAccess } from "@/services/billing-access.services";
import { CATEGORY_LABELS, loadReimbursableClaims, settleClaimsInPayroll } from "@/services/expense.services";
import { loadPayrollBonuses, settleBonusesInPayroll, type PayrollBonusLine } from "@/services/bonus.services";
import { loadDeclarationAdjustments } from "@/services/tax-declaration.services";
import { loadRoster, type RosterEntry } from "@/services/roster.services";
import { calculatePayroll, type CalcLoan, type CalcSettings } from "@/services/payroll-calc";
import { parseWeeklyOff } from "@/services/payroll-settings.services";
import { holidayDatesBetween, holidaysForBranch } from "@/services/holiday.services";
import {
  isStatutoryActive,
  loadEmployeeStatutoryMap,
  loadStatutorySettings,
  loadYearToDate,
} from "@/services/statutory.services";
import { fromCents, lockAndMeasure, toCents, totalDueCents } from "@/services/recoverable.services";
import { autoCreditCompOff, offDayOutcomesBetween } from "@/services/off-day-work.services";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type { generatePayrollSchema } from "@/validator/payroll.validator";
import type { TaxRegime } from "@/drizzle/schema";
import type { EmployeeStatutory, StatutorySettings, YearToDate } from "@/services/statutory-calc";

export type PayrollItem = typeof items.$inferSelect;
export type PayrollRunRow = typeof runs.$inferSelect;

const num = (value: string | null | undefined) => (value === null || value === undefined ? null : Number(value));

const loadSettings = async (organizationId: string): Promise<CalcSettings & { currencyCode: string }> => {
  const [s] = await db
    .select()
    .from(organizationPayrollSettingsTable)
    .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
    .limit(1);
  return {
    currencyCode: s?.currencyCode ?? "INR",
    overtimeCalculationMethod: s?.overtimeCalculationMethod ?? "hourly_rate_multiplier",
    overtimeFixedAmountPerHour: num(s?.overtimeFixedAmountPerHour),
    overtimeHourlyRateMultiplier: num(s?.overtimeHourlyRateMultiplier) ?? 1.5,
    overtimeHoursPerWorkday: num(s?.overtimeHoursPerWorkday),
    lateFineMethod: s?.lateFineMethod ?? "none",
    lateFineAmount: num(s?.lateFineAmount),
    lateFineCapPerPayPeriod: num(s?.lateFineCapPerPayPeriod),
    weeklyOffDays: s ? parseWeeklyOff(s.weeklyOffDays) : [0],
    autoDeductLoans: s?.autoDeductLoans ?? false,
    paidHolidays: s?.paidHolidays ?? false,
    overtimeApprovalRequired: s?.overtimeApprovalRequired ?? false,
    offDayWorkPolicy: s?.offDayWorkPolicy ?? "manager",
    weeklyOffWorkMultiplier: num(s?.weeklyOffWorkMultiplier) ?? 1,
    holidayWorkMultiplier: num(s?.holidayWorkMultiplier) ?? 2,
  };
};

const shiftMinutes = (start: string, end: string, breakMinutes: number) => {
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  let span = toMin(end) - toMin(start);
  if (span <= 0) span += 1440;
  return Math.max(span - breakMinutes, 0);
};

export const listRuns = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  return ok(
    await db
      .select()
      .from(runs)
      .where(eq(runs.organizationId, organizationId))
      .orderBy(desc(runs.periodStart)),
  );
};

export const getRun = async (organizationId: string, requesterId: string, runId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.organizationId, organizationId), eq(runs.id, runId)))
    .limit(1);
  if (!run) return fail("not-found", "Payroll run not found");
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.organizationId, organizationId), eq(items.runId, runId)))
    .orderBy(items.employeeName);
  return ok({ run, items: rows });
};

export const generateRun = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof generatePayrollSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return billing;

  const [existing] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.organizationId, organizationId),
        eq(runs.periodStart, input.periodStart),
        eq(runs.periodEnd, input.periodEnd),
      ),
    )
    .limit(1);
  if (existing?.status === "finalized") {
    return fail("conflict", "Payroll for this period is already finalized");
  }

  const { values, skipped } = await buildPayrollItems(organizationId, input, {
    recoverLoans: true,
    reimburseClaims: true,
    payBonuses: true,
    skipSettledFrom: input.periodStart,
  });

  const runId = await db.transaction(async (tx) => {
    let id = existing?.id;
    if (id) {
      await tx.delete(items).where(and(eq(items.organizationId, organizationId), eq(items.runId, id)));
      await tx
        .update(runs)
        .set({ utcOffsetMinutes: input.utcOffsetMinutes, generatedByUserId: requesterId, createdAt: new Date() })
        .where(eq(runs.id, id));
    } else {
      const [created] = await tx
        .insert(runs)
        .values({
          organizationId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          utcOffsetMinutes: input.utcOffsetMinutes,
          generatedByUserId: requesterId,
        })
        .returning({ id: runs.id });
      id = created.id;
    }
    if (values.length > 0) await tx.insert(items).values(values.map((v) => ({ ...v, runId: id! })));
    return id;
  });

  const detail = await getRun(organizationId, requesterId, runId);
  if (!detail.ok) return detail;
  return ok({ ...detail.data, skipped });
};

type BuildOptions = {
  /** Only these employees (membership ids); by default everyone on payroll. */
  membershipIds?: string[];
  /** Include employees who are no longer active, for a leaver's final settlement. */
  includeInactive?: boolean;
  /** Deduct loan installments; a final settlement recovers loans as its own lines instead. */
  recoverLoans: boolean;
  /** Pay approved expense claims; a final settlement reimburses them as its own lines instead. */
  reimburseClaims: boolean;
  /** Pay approved bonuses due with payroll, as a taxable earning. */
  payBonuses?: boolean;
  /** Leave out employees whose full & final settlement already covers this date. */
  skipSettledFrom?: string;
};

/**
 * Works out each employee's pay for a period: attendance, leave, holidays, roster, overtime, statutory
 * deductions and, when asked, loan installments and expense reimbursements. Used by payroll runs and
 * by full & final settlements (for one employee's last days).
 */
export const buildPayrollItems = async (
  organizationId: string,
  input: z.infer<typeof generatePayrollSchema>,
  options: BuildOptions,
) => {
  const settings = await loadSettings(organizationId);
  const employees = await db
    .select({
      id: memberships.id,
      userId: memberships.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      employeeCode: memberships.employeeCode,
      jobTitle: memberships.jobTitle,
      hireDate: memberships.hireDate,
      compensationType: memberships.compensationType,
      compensationAmount: memberships.compensationAmount,
      compensationCurrency: memberships.compensationCurrency,
      salaryComponents: memberships.salaryComponents,
      departmentName: departmentsTable.name,
      branchId: memberships.branchId,
      branchName: branchesTable.name,
      branchPtState: branchesTable.ptState,
      branchPtFlatAmount: branchesTable.ptFlatAmount,
      shiftStart: shiftsTable.startTime,
      shiftEnd: shiftsTable.endTime,
      shiftBreak: shiftsTable.breakMinutes,
    })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .leftJoin(departmentsTable, eq(departmentsTable.id, memberships.departmentId))
    .leftJoin(branchesTable, eq(branchesTable.id, memberships.branchId))
    .leftJoin(shiftsTable, eq(shiftsTable.id, memberships.shiftId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        options.includeInactive ? undefined : eq(memberships.isActive, true),
        options.membershipIds ? inArray(memberships.id, options.membershipIds) : undefined,
        or(
          ne(memberships.role, UserRole.SUPER_ADMIN),
          eq(memberships.includeInPayroll, true),
        ),
      ),
    );

  // Leavers whose full & final settlement already pays these days.
  const settled = options.skipSettledFrom
    ? new Set(
        (
          await db
            .select({ membershipId: finalSettlementsTable.userOrganizationId })
            .from(finalSettlementsTable)
            .where(
              and(
                eq(finalSettlementsTable.organizationId, organizationId),
                inArray(finalSettlementsTable.status, ["finalized", "paid"]),
                lte(finalSettlementsTable.salaryFrom, input.periodEnd),
              ),
            )
        ).map((row) => row.membershipId),
      )
    : new Set<string>();

  const skipped: string[] = [];
  const payable = employees.filter((e) => {
    if (settled.has(e.id)) {
      skipped.push(`${e.fname} ${e.lname} (settled in full & final)`);
      return false;
    }
    const ready = e.compensationType && e.compensationAmount !== null;
    if (!ready) skipped.push(`${e.fname} ${e.lname}`);
    return ready;
  });

  const [attendance, leaveRows, loanRows, repaidRows, payrollPaid, holidays, claimRows, bonusRows] = await Promise.all([
    computeDailyAttendance(organizationId, {
      from: input.periodStart,
      to: input.periodEnd,
      utcOffsetMinutes: input.utcOffsetMinutes,
    }),
    db
      .select({
        userOrganizationId: leaveRequestsTable.userOrganizationId,
        startDate: leaveRequestsTable.startDate,
        endDate: leaveRequestsTable.endDate,
        isHalfDay: leaveRequestsTable.isHalfDay,
        isPaid: leaveTypesTable.isPaid,
      })
      .from(leaveRequestsTable)
      .innerJoin(leaveTypesTable, eq(leaveTypesTable.id, leaveRequestsTable.leaveTypeId))
      .where(
        and(
          eq(leaveRequestsTable.organizationId, organizationId),
          eq(leaveRequestsTable.status, "approved"),
        ),
      ),
    db
      .select()
      .from(recoverables)
      .where(
        and(
          eq(recoverables.organizationId, organizationId),
          inArray(recoverables.status, ["disbursed", "active"]),
        ),
      ),
    db
      .select({ recoverableId: repayments.recoverableId, amount: repayments.amount })
      .from(repayments)
      .where(and(eq(repayments.organizationId, organizationId), eq(repayments.status, "confirmed"))),
    db
      .select({ recoverableId: repayments.recoverableId })
      .from(repayments)
      .where(
        and(
          eq(repayments.organizationId, organizationId),
          eq(repayments.source, "payroll"),
          eq(repayments.payrollPeriodStart, input.periodStart),
          eq(repayments.payrollPeriodEnd, input.periodEnd),
        ),
      ),
    holidayDatesBetween(organizationId, input.periodStart, input.periodEnd),
    loadReimbursableClaims(organizationId, input.periodEnd),
    options.payBonuses ? loadPayrollBonuses(organizationId) : new Map<string, PayrollBonusLine[]>(),
  ]);

  const repaidByLoan = new Map<string, number>();
  for (const r of repaidRows) {
    repaidByLoan.set(r.recoverableId, (repaidByLoan.get(r.recoverableId) ?? 0) + toCents(r.amount));
  }
  const alreadyDeducted = new Set(payrollPaid.map((r) => r.recoverableId));

  const statutorySettings = (await loadStatutorySettings(organizationId)).calc;
  const statutoryActive = isStatutoryActive(statutorySettings);
  const [profileMap, ytdMap] = statutoryActive
    ? await Promise.all([
        loadEmployeeStatutoryMap(organizationId),
        loadYearToDate(organizationId, input.periodStart, input.periodEnd),
      ])
    : [null, null];
  // Employees who declared for this financial year: their regime, deductions and previous-employer income.
  const declarations = statutoryActive ? await loadDeclarationAdjustments(organizationId, input.periodEnd) : null;
  // Rotations and day overrides decide which days rostered employees work or have off.
  const roster = await loadRoster(organizationId, input.periodStart, input.periodEnd, payable.map((e) => e.id));

  const approvalRows = settings.overtimeApprovalRequired
    ? await db
        .select({
          userOrganizationId: overtimeApprovalsTable.userOrganizationId,
          date: overtimeApprovalsTable.date,
          minutes: overtimeApprovalsTable.approvedMinutes,
        })
        .from(overtimeApprovalsTable)
        .where(
          and(
            eq(overtimeApprovalsTable.organizationId, organizationId),
            eq(overtimeApprovalsTable.status, "approved"),
            gte(overtimeApprovalsTable.date, input.periodStart),
            lte(overtimeApprovalsTable.date, input.periodEnd),
          ),
        )
    : [];

  // Days worked on a weekly off or holiday: decided ones are paid or not; undecided ones follow the policy.
  const offDayOutcomes = await offDayOutcomesBetween(organizationId, input.periodStart, input.periodEnd);
  const offDayPendingBy = new Map<string, { date: string; days: number }[]>();

  const values = payable.map((e) => {
    const loans: CalcLoan[] = (options.recoverLoans ? loanRows : [])
      .filter(
        (l) =>
          l.userOrganizationId === e.id &&
          l.installmentAmount !== null &&
          Number(l.installmentAmount) > 0 &&
          (!l.firstRepaymentDate || l.firstRepaymentDate <= input.periodEnd) &&
          !alreadyDeducted.has(l.id),
      )
      .map((l) => ({
        recoverableId: l.id,
        label: `${l.type === "loan" ? "Loan" : "Salary advance"}${l.description ? ` - ${l.description}` : ""}`,
        installmentCents: toCents(l.installmentAmount ?? 0),
        outstandingCents: totalDueCents(l) - (repaidByLoan.get(l.id) ?? 0),
      }));

    const reimbursementLines = (options.reimburseClaims ? claimRows : [])
      .filter((claim) => claim.userOrganizationId === e.id)
      .map((claim) => ({
        claimId: claim.id,
        label: `${CATEGORY_LABELS[claim.category]} (${claim.expenseDate})`,
        amount: Number(claim.amount).toFixed(2),
      }));
    const reimbursementCents = reimbursementLines.reduce((sum, line) => sum + toCents(line.amount), 0);
    const bonusLines = bonusRows.get(e.id) ?? [];
    const bonusCents = bonusLines.reduce((sum, line) => sum + toCents(line.amount), 0);

    const calc = calculatePayroll({
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      hireDate: e.hireDate,
      compensationType: e.compensationType!,
      compensationAmount: Number(e.compensationAmount),
      components: e.salaryComponents,
      shiftExpectedMinutes:        e.shiftStart && e.shiftEnd ? shiftMinutes(e.shiftStart, e.shiftEnd, e.shiftBreak ?? 0) : null,
      settings,
      days: attendance.filter((d) => d.employeeId === e.userId),
      holidays: holidaysForBranch(holidays, e.branchId),
      leaves: leaveRows.filter((l) => l.userOrganizationId === e.id),
      loans,
      bonusCents,
      rosterDays: rosterDaysFor(roster.byMembership.get(e.id)),
      offDayOutcomes: offDayOutcomes.get(e.id),
      overtimeApprovals: new Map(
        approvalRows.filter((r) => r.userOrganizationId === e.id).map((r) => [r.date, r.minutes]),
      ),
      statutory:
        profileMap && ytdMap
          ? withDeclaration(branchStatutory(statutorySettings, e), profileMap.get(e.id), ytdMap.get(e.id), declarations?.get(e.id))
          : undefined,
    });

    const one = (n: number) => n.toFixed(1);
    if (calc.offDayPending.length) offDayPendingBy.set(e.id, calc.offDayPending);
    return {
      organizationId,
      userId: e.userId,
      userOrganizationId: e.id,
      employeeName: `${e.fname} ${e.lname}`,
      employeeCode: e.employeeCode,
      jobTitle: e.jobTitle,
      departmentName: e.departmentName,
      branchId: e.branchId,
      branchName: e.branchName,
      compensationType: e.compensationType!,
      compensationAmount: Number(e.compensationAmount).toFixed(2),
      currencyCode: e.compensationCurrency ?? settings.currencyCode,
      workingDays: one(calc.workingDays),
      presentDays: one(calc.presentDays),
      halfDays: one(calc.halfDays),
      paidLeaveDays: one(calc.paidLeaveDays),
      unpaidLeaveDays: one(calc.unpaidLeaveDays),
      absentDays: one(calc.absentDays),
      incompleteDays: calc.incompleteDays,
      workedMinutes: calc.workedMinutes,
      overtimeMinutes: calc.overtimeMinutes,
      lateCount: calc.lateCount,
      lateMinutes: calc.lateMinutes,
      basePay: fromCents(calc.basePayCents),
      overtimePay: fromCents(calc.overtimePayCents),
      allowancesPay: fromCents(calc.allowancesPayCents),
      grossPay: fromCents(calc.grossPayCents),
      lateFine: fromCents(calc.lateFineCents),
      componentDeductions: fromCents(calc.componentDeductionsCents),
      componentLines: calc.componentLines.map((l) => ({
        name: l.name,
        kind: l.kind,
        amount: fromCents(l.amountCents),
      })),
      loanDeduction: fromCents(calc.loanDeductionCents),
      totalDeductions: fromCents(calc.totalDeductionsCents),
      // Reimbursements are paid on top of net salary: outside gross, so no PF, ESI, PT or TDS applies.
      netPay: fromCents(calc.netPayCents + reimbursementCents),
      statutory: calc.statutory,
      loanLines: calc.loanLines.map((l) => ({
        recoverableId: l.recoverableId,
        label: l.label,
        amount: fromCents(l.amountCents),
      })),
      reimbursements: fromCents(reimbursementCents),
      reimbursementLines,
      bonus: fromCents(calc.bonusPayCents),
      bonusLines,
      offDayDays: one(calc.offDayDays),
      offDayPay: fromCents(calc.offDayPayCents),
      offDayPendingDays: one(calc.offDayPending.reduce((sum, day) => sum + day.days, 0)),
    };
  });

  // "Always comp-off": undecided days become comp-off credits now, so nothing is left pending.
  if (settings.offDayWorkPolicy === "comp_off") {
    for (const [membershipId, pending] of offDayPendingBy) {
      if (!(await autoCreditCompOff(organizationId, membershipId, pending))) continue;
      const item = values.find((value) => value.userOrganizationId === membershipId);
      if (item) item.offDayPendingDays = "0.0";
    }
  }
  return { values, skipped };
};

export const deleteRun = async (organizationId: string, requesterId: string, runId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const [run] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(and(eq(runs.organizationId, organizationId), eq(runs.id, runId)))
    .limit(1);
  if (!run) return fail("not-found", "Payroll run not found");
  if (run.status === "finalized") return fail("conflict", "Finalized payroll cannot be deleted");
  await db.delete(runs).where(and(eq(runs.organizationId, organizationId), eq(runs.id, runId)));
  return ok(null);
};

export const finalizeRun = async (organizationId: string, requesterId: string, runId: string) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return billing;

  const result = await finalizeInTransaction(organizationId, requesterId, runId).catch((error: unknown) => {
    if (error instanceof FinalizeConflict) return fail("conflict", error.message);
    throw error;
  });
  if (result.ok) await notifySlipsReady(organizationId, requesterId, runId);
  return result;
};

/** Raised inside the finalize transaction to roll back everything it already wrote. */
class FinalizeConflict extends Error {}

const finalizeInTransaction = (organizationId: string, requesterId: string, runId: string) =>
  db.transaction(async (tx): Promise<ServiceResult<null>> => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.organizationId, organizationId), eq(runs.id, runId)))
      .for("update")
      .limit(1);
    if (!run) return fail("not-found", "Payroll run not found");
    if (run.status === "finalized") return fail("conflict", "Payroll is already finalized");

    const rows = await tx
      .select()
      .from(items)
      .where(and(eq(items.organizationId, organizationId), eq(items.runId, runId)));

    for (const item of rows) {
      for (const line of item.loanLines) {
        const locked = await lockAndMeasure(tx, organizationId, line.recoverableId);
        const amountCents = toCents(line.amount);
        if (!locked.ok || amountCents > locked.data.outstanding) {
          // Thrown, not returned: returning would commit the repayments already recorded for earlier employees.
          throw new FinalizeConflict(
            `Loan balance changed for ${item.employeeName}. Regenerate the payroll and try again`,
          );
        }
        await tx.insert(repayments).values({
          organizationId,
          recoverableId: line.recoverableId,
          amount: line.amount,
          currencyCode: item.currencyCode,
          source: "payroll",
          status: "confirmed",
          payrollPeriodStart: run.periodStart,
          payrollPeriodEnd: run.periodEnd,
          notes: "Deducted from salary",
          submittedByUserId: requesterId,
          reviewedByUserId: requesterId,
          reviewedAt: new Date(),
        });
        await tx
          .update(recoverables)
          .set({
            status: amountCents === locked.data.outstanding ? "completed" : "active",
            updatedAt: new Date(),
          })
          .where(eq(recoverables.id, line.recoverableId));
      }
    }

    const claimIds = rows.flatMap((item) => item.reimbursementLines.map((line) => line.claimId));
    if (!(await settleClaimsInPayroll(tx, organizationId, runId, claimIds))) {
      // Throwing rolls back the loan repayments recorded above as well.
      throw new FinalizeConflict("An expense claim in this payroll was cancelled or paid since it was generated. Regenerate the payroll and try again");
    }
    const bonusItemIds = rows.flatMap((item) => item.bonusLines.map((line) => line.bonusItemId));
    if (!(await settleBonusesInPayroll(tx, organizationId, runId, bonusItemIds))) {
      throw new FinalizeConflict("A bonus in this payroll was paid since it was generated. Regenerate the payroll and try again");
    }

    await tx
      .update(runs)
      .set({ status: "finalized", finalizedAt: new Date(), finalizedByUserId: requesterId })
      .where(eq(runs.id, runId));
    return ok(null);
  });

const notifySlipsReady = async (organizationId: string, requesterId: string, runId: string) => {
  const [run] = await db
    .select({ periodStart: runs.periodStart, periodEnd: runs.periodEnd })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const recipients = await db
    .select({ userId: items.userId })
    .from(items)
    .where(and(eq(items.organizationId, organizationId), eq(items.runId, runId)));
  await notify({
    organizationId,
    userIds: recipients.map((row) => row.userId).filter((id) => id !== requesterId),
    type: "payslip_ready",
    title: "Your salary slip is ready",
    body: run ? `Pay period ${run.periodStart} to ${run.periodEnd}` : undefined,
    link: "/salary-slips",
  });
};

export const listMySlips = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const rows = await db
    .select({
      id: items.id,
      periodStart: runs.periodStart,
      periodEnd: runs.periodEnd,
      grossPay: items.grossPay,
      totalDeductions: items.totalDeductions,
      netPay: items.netPay,
      currencyCode: items.currencyCode,
      finalizedAt: runs.finalizedAt,
    })
    .from(items)
    .innerJoin(runs, and(eq(runs.organizationId, items.organizationId), eq(runs.id, items.runId)))
    .where(
      and(
        eq(items.organizationId, organizationId),
        eq(items.userId, requesterId),
        eq(runs.status, "finalized"),
      ),
    )
    .orderBy(desc(runs.periodStart));
  return ok(rows);
};

export const requestSlipWhatsApp = async (
  organizationId: string,
  requesterId: string,
  itemId: string,
): Promise<ServiceResult<null>> => {
  const slip = await getSlip(organizationId, requesterId, itemId);
  if (!slip.ok) return slip;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return billing;
  if (slip.data.run.status !== "finalized") {
    return fail("conflict", "Salary slip can be sent once the payroll is finalized");
  }
  const recipient = await loadSlipDelivery(organizationId, itemId);
  if (!recipient || recipient.phone.startsWith("g")) {
    return fail("invalid", "This employee has no phone number linked for WhatsApp");
  }
  const queued = await queueDelivery({
    organizationId,
    requesterId,
    channel: "whatsapp",
    messageType: "salary_slip",
    relatedId: itemId,
    recipientUserId: slip.data.item.userId,
    recipientMasked: maskPhone(recipient.phone),
  });
  return queued.ok ? ok(null) : queued;
};

export const requestSlipEmail = async (
  organizationId: string,
  requesterId: string,
  itemId: string,
): Promise<ServiceResult<null>> => {
  const slip = await getSlip(organizationId, requesterId, itemId);
  if (!slip.ok) return slip;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return billing;
  if (slip.data.run.status !== "finalized") {
    return fail("conflict", "Salary slip can be sent once the payroll is finalized");
  }
  const recipient = await loadSlipDelivery(organizationId, itemId);
  if (!recipient?.email) {
    return fail("invalid", "This employee has no Google email linked");
  }
  const queued = await queueDelivery({
    organizationId,
    requesterId,
    channel: "email",
    messageType: "salary_slip",
    relatedId: itemId,
    recipientUserId: slip.data.item.userId,
    recipientMasked: maskEmail(recipient.email),
  });
  return queued.ok ? ok(null) : queued;
};

/** Slip data and recipient for the WhatsApp worker. No access check; the producer already authorized. */
export const loadSlipDelivery = async (organizationId: string, itemId: string) => {
  const [row] = await db
    .select({
      item: items,
      run: runs,
      organizationName: organizationsTable.name,
      phone: usersTable.phone,
      email: usersTable.email,
      emailVerified: usersTable.emailVerified,
    })
    .from(items)
    .innerJoin(runs, and(eq(runs.organizationId, items.organizationId), eq(runs.id, items.runId)))
    .innerJoin(organizationsTable, eq(organizationsTable.id, items.organizationId))
    .innerJoin(usersTable, eq(usersTable.id, items.userId))
    .where(and(eq(items.organizationId, organizationId), eq(items.id, itemId)))
    .limit(1);
  if (!row) return null;
  const { item, run } = row;
  return {
    phone: row.phone,
    email: row.email && row.emailVerified ? row.email : null,
    pdf: { item, run, organizationName: row.organizationName },
    params: [
      item.employeeName,
      row.organizationName,
      `${run.periodStart} to ${run.periodEnd}`,
      `${item.currencyCode} ${item.grossPay}`,
      `${item.currencyCode} ${item.totalDeductions}`,
      `${item.currencyCode} ${item.netPay}`,
    ],
  };
};

export const getSlip = async (organizationId: string, requesterId: string, itemId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const isManager = isOrganizationManager(access.data);

  const [row] = await db
    .select({
      item: items,
      run: runs,
      organizationName: organizationsTable.name,
      phone: usersTable.phone,
      email: usersTable.email,
      emailVerified: usersTable.emailVerified,
    })
    .from(items)
    .innerJoin(runs, and(eq(runs.organizationId, items.organizationId), eq(runs.id, items.runId)))
    .innerJoin(organizationsTable, eq(organizationsTable.id, items.organizationId))
    .innerJoin(usersTable, eq(usersTable.id, items.userId))
    .where(and(eq(items.organizationId, organizationId), eq(items.id, itemId)))
    .limit(1);
  if (!row) return fail("not-found", "Salary slip not found");
  if (!isManager && (row.item.userId !== requesterId || row.run.status !== "finalized")) {
    return fail("not-found", "Salary slip not found");
  }
  const { phone, email, emailVerified, ...slip } = row;
  return ok({ ...slip, delivery: await sendableChannels(organizationId, "salary_slip", deliveryChannels({ phone, email, emailVerified })) });
};

/**
 * TDS inputs for one employee. A tax declaration for the year overrides the statutory profile's
 * regime and deductions, and income and TDS from a previous employer count as earned this year.
 */
const withDeclaration = (
  settings: StatutorySettings,
  employee: EmployeeStatutory,
  ytd: YearToDate,
  declaration: { regime: TaxRegime; deductions: number; previousGross: number; previousTds: number } | undefined,
) =>
  declaration
    ? {
        settings,
        employee: { ...employee, taxRegime: declaration.regime, declaredDeductions: declaration.deductions },
        ytd: { ...ytd, gross: ytd.gross + declaration.previousGross, tds: ytd.tds + declaration.previousTds },
      }
    : { settings, employee, ytd };

/** Work or off for each date that comes from a rotation or an override; default-shift dates are left out. */
export const rosterDaysFor = (days: Map<string, RosterEntry> | undefined) => {
  const result = new Map<string, "work" | "off">();
  for (const [date, entry] of days ?? []) {
    if (entry.source !== "default") result.set(date, entry.shiftId ? "work" : "off");
  }
  return result;
};

/** A branch with its own professional tax state uses that state's slabs instead of the organization's. */
const branchStatutory = (
  settings: StatutorySettings,
  employee: { branchPtState: string | null; branchPtFlatAmount: string | null },
): StatutorySettings =>
  settings.ptEnabled && employee.branchPtState
    ? {
        ...settings,
        ptState: employee.branchPtState,
        ptFlatAmount: employee.branchPtFlatAmount === null ? null : Number(employee.branchPtFlatAmount),
      }
    : settings;
