import { and, eq, gte, lte } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  organizationPayrollSettingsTable,
  overtimeApprovalsTable as approvals,
  payrollRunsTable,
  UserRole,
  userOrganizationsTable,
} from "@/drizzle/schema";
import { PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { computeDailyAttendance } from "@/services/attendance.services";
import { notify } from "@/services/notification.services";
import { fail, ok } from "@/utils/result";
import type { listOvertimeQuerySchema, reviewOvertimeSchema } from "@/validator/overtime.validator";

export type OvertimeStatus = "pending" | "approved" | "rejected" | "auto";

const earnedOvertime = (day: { status: string; workedMinutes: number | null; expectedMinutes: number | null }) =>
  day.status === "present" && day.workedMinutes !== null && day.expectedMinutes
    ? Math.max(0, day.workedMinutes - day.expectedMinutes)
    : 0;

const approvalRequired = async (organizationId: string) => {
  const [row] = await db
    .select({ value: organizationPayrollSettingsTable.overtimeApprovalRequired })
    .from(organizationPayrollSettingsTable)
    .where(eq(organizationPayrollSettingsTable.organizationId, organizationId))
    .limit(1);
  return row?.value ?? false;
};

export const listOvertime = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof listOvertimeQuerySchema>,
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const [required, days, decisions, members] = await Promise.all([
    approvalRequired(organizationId),
    computeDailyAttendance(organizationId, {
      ...query,
      employeeRole: access.data.role === UserRole.HR ? UserRole.EMPLOYEE : undefined,
    }),
    db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, organizationId),
          gte(approvals.date, query.from),
          lte(approvals.date, query.to),
        ),
      ),
    db
      .select({ id: userOrganizationsTable.id, userId: userOrganizationsTable.userId })
      .from(userOrganizationsTable)
      .where(eq(userOrganizationsTable.organizationId, organizationId)),
  ]);
  const memberByUser = new Map(members.map((m) => [m.userId, m.id]));
  const decisionByKey = new Map(decisions.map((d) => [`${d.userOrganizationId}|${d.date}`, d]));

  const rows = days
    .map((day) => ({ day, minutes: earnedOvertime(day) }))
    .filter(({ minutes }) => minutes > 0)
    .map(({ day, minutes }) => {
      const decision = decisionByKey.get(`${memberByUser.get(day.employeeId)}|${day.date}`);
      const status: OvertimeStatus = !required ? "auto" : (decision?.status ?? "pending");
      return {
        employeeId: day.employeeId,
        employeeName: day.employeeName,
        date: day.date,
        workedMinutes: day.workedMinutes ?? 0,
        expectedMinutes: day.expectedMinutes ?? 0,
        overtimeMinutes: minutes,
        status,
        approvedMinutes: decision?.status === "approved" ? decision.approvedMinutes : 0,
        note: decision?.note ?? null,
      };
    })
    .filter((row) => !query.status || row.status === query.status)
    .sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName));

  return ok({ approvalRequired: required, items: rows });
};

export const reviewOvertime = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof reviewOvertimeSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  if (!(await approvalRequired(organizationId))) {
    return fail("conflict", "Overtime approval is turned off in payroll settings");
  }

  const saved: string[] = [];
  for (const entry of input.entries) {
    const [member] = await db
      .select({ id: userOrganizationsTable.id, role: userOrganizationsTable.role })
      .from(userOrganizationsTable)
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          eq(userOrganizationsTable.userId, entry.employeeId),
        ),
      )
      .limit(1);
    if (!member) return fail("not-found", "Employee not found in this organization");
    if (access.data.role === UserRole.HR && member.role !== UserRole.EMPLOYEE) {
      return fail("forbidden");
    }

    const [finalized] = await db
      .select({ id: payrollRunsTable.id })
      .from(payrollRunsTable)
      .where(
        and(
          eq(payrollRunsTable.organizationId, organizationId),
          eq(payrollRunsTable.status, "finalized"),
          lte(payrollRunsTable.periodStart, entry.date),
          gte(payrollRunsTable.periodEnd, entry.date),
        ),
      )
      .limit(1);
    if (finalized) return fail("conflict", `Payroll for ${entry.date} is already finalized`);

    const [day] = await computeDailyAttendance(organizationId, {
      from: entry.date,
      to: entry.date,
      employeeId: entry.employeeId,
      utcOffsetMinutes: input.utcOffsetMinutes,
    });
    const earned = day ? earnedOvertime(day) : 0;
    if (earned <= 0) return fail("invalid", `No overtime on ${entry.date}`);

    const minutes = entry.status === "approved" ? Math.min(entry.approvedMinutes ?? earned, earned) : 0;
    const values = {
      status: entry.status,
      approvedMinutes: minutes,
      note: entry.note ?? null,
      reviewedByUserId: requesterId,
      reviewedAt: new Date(),
    };
    await db
      .insert(approvals)
      .values({ organizationId, userOrganizationId: member.id, date: entry.date, ...values })
      .onConflictDoUpdate({ target: [approvals.userOrganizationId, approvals.date], set: values });
    saved.push(entry.employeeId);

    await notify({
      organizationId,
      userIds: [entry.employeeId],
      type: `overtime_${entry.status}`,
      title: `Overtime ${entry.status}`,
      body:
        entry.status === "approved"
          ? `${minutes} minutes of overtime on ${entry.date} were approved.`
          : `Overtime on ${entry.date} was not approved.`,
      link: "/attendance/my",
    });
  }
  return ok({ updated: input.entries.length });
};
