import { and, desc, eq, gte, inArray, lte, ne, or } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  departmentsTable,
  employeeRecoverableRepaymentsTable as repayments,
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
import { ALL_ROLES, MANAGER_ROLES, requireRole } from "@/services/access.services";
import { computeDailyAttendance } from "@/services/attendance.services";
import { notify } from "@/services/notification.services";
import { enqueueSalarySlipWhatsApp } from "@/queue/producer/sendSalarySlipWhatsApp";
import { enqueueSalarySlipEmail } from "@/queue/producer/sendDocumentEmail";
import { deliveryChannels } from "@/services/user.services";
import { calculatePayroll, type CalcLoan, type CalcSettings } from "@/services/payroll-calc";
import { parseWeeklyOff } from "@/services/payroll-settings.services";
import { holidayDatesBetween } from "@/services/holiday.services";
import {
  isStatutoryActive,
  loadEmployeeStatutoryMap,
  loadStatutorySettings,
  loadYearToDate,
} from "@/services/statutory.services";
import { fromCents, lockAndMeasure, toCents, totalDueCents } from "@/services/recoverable.services";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type { generatePayrollSchema } from "@/validator/payroll.validator";

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
      shiftStart: shiftsTable.startTime,
      shiftEnd: shiftsTable.endTime,
      shiftBreak: shiftsTable.breakMinutes,
    })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .leftJoin(departmentsTable, eq(departmentsTable.id, memberships.departmentId))
    .leftJoin(shiftsTable, eq(shiftsTable.id, memberships.shiftId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.isActive, true),
        or(
          ne(memberships.role, UserRole.SUPER_ADMIN),
          eq(memberships.includeInPayroll, true),
        ),
      ),
    );

  const skipped: string[] = [];
  const payable = employees.filter((e) => {
    const ready = e.compensationType && e.compensationAmount !== null;
    if (!ready) skipped.push(`${e.fname} ${e.lname}`);
    return ready;
  });

  const [attendance, leaveRows, loanRows, repaidRows, payrollPaid, holidays] = await Promise.all([
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

  const values = payable.map((e) => {
    const loans: CalcLoan[] = loanRows
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
      holidays,
      leaves: leaveRows.filter((l) => l.userOrganizationId === e.id),
      loans,
      overtimeApprovals: new Map(
        approvalRows.filter((r) => r.userOrganizationId === e.id).map((r) => [r.date, r.minutes]),
      ),
      statutory:
        profileMap && ytdMap
          ? { settings: statutorySettings, employee: profileMap.get(e.id), ytd: ytdMap.get(e.id) }
          : undefined,
    });

    const one = (n: number) => n.toFixed(1);
    return {
      organizationId,
      userId: e.userId,
      userOrganizationId: e.id,
      employeeName: `${e.fname} ${e.lname}`,
      employeeCode: e.employeeCode,
      jobTitle: e.jobTitle,
      departmentName: e.departmentName,
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
      netPay: fromCents(calc.netPayCents),
      statutory: calc.statutory,
      loanLines: calc.loanLines.map((l) => ({
        recoverableId: l.recoverableId,
        label: l.label,
        amount: fromCents(l.amountCents),
      })),
    };
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

  const result = await db.transaction(async (tx): Promise<ServiceResult<null>> => {
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
          return fail(
            "conflict",
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

    await tx
      .update(runs)
      .set({ status: "finalized", finalizedAt: new Date(), finalizedByUserId: requesterId })
      .where(eq(runs.id, runId));
    return ok(null);
  });
  if (result.ok) {
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
  }
  return result;
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
  if (slip.data.run.status !== "finalized") {
    return fail("conflict", "Salary slip can be sent once the payroll is finalized");
  }
  if (!slip.data.delivery.whatsapp) {
    return fail("invalid", "This employee has no phone number linked for WhatsApp");
  }
  await enqueueSalarySlipWhatsApp({ organizationId, itemId, requestedByUserId: requesterId });
  return ok(null);
};

export const requestSlipEmail = async (
  organizationId: string,
  requesterId: string,
  itemId: string,
): Promise<ServiceResult<null>> => {
  const slip = await getSlip(organizationId, requesterId, itemId);
  if (!slip.ok) return slip;
  if (slip.data.run.status !== "finalized") {
    return fail("conflict", "Salary slip can be sent once the payroll is finalized");
  }
  if (!slip.data.delivery.email) {
    return fail("invalid", "This employee has no Google email linked");
  }
  await enqueueSalarySlipEmail({ organizationId, itemId, requestedByUserId: requesterId });
  return ok(null);
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
  const isManager = MANAGER_ROLES.includes(access.data.role);

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
  return ok({ ...slip, delivery: deliveryChannels({ phone, email, emailVerified }) });
};
