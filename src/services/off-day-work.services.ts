import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  leaveCreditsTable as credits,
  leaveTypesTable as types,
  offDayWorkTable as offDayWork,
  payrollItemsTable,
  payrollRunsTable,
  userOrganizationsTable,
  usersTable,
  type OffDayOutcome,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  branchFilter,
  canManageMember,
  getEmployeeMembership,
  PEOPLE_MANAGER_ROLES,
  requireRole,
} from "@/services/access.services";
import { getDailyAttendance } from "@/services/attendance.services";
import { addDays } from "@/services/leave-balance";
import { notify, peopleManagerIds } from "@/services/notification.services";
import { loadOffDays } from "@/services/off-days";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  decideOffDayWorkSchema,
  leaveCreditQuerySchema,
  offDayWorkQuerySchema,
  requestOffDayOutcomeSchema,
} from "@/validator/leave.validator";

// How far back worked off-days are listed for requests and decisions.
const LOOKBACK_DAYS = 60;

export type WorkedOffDay = {
  employeeId: string;
  employeeName: string;
  membershipId: string;
  date: string;
  kind: "weekly_off" | "holiday";
  days: 0.5 | 1;
  workedMinutes: number | null;
  requestedOutcome: "comp_off" | "pay" | null;
  outcome: OffDayOutcome | null;
  /** True when the organization's policy settled it at payroll rather than a person. */
  automatic: boolean;
};

/** Days in the range someone worked on their weekly off or a holiday, with any request and decision. */
const workedOffDays = async (
  organizationId: string,
  requesterId: string,
  query: { from: string; to: string; utcOffsetMinutes: number; employeeId?: string },
): Promise<ServiceResult<WorkedOffDay[]>> => {
  const daily = await getDailyAttendance(organizationId, requesterId, query);
  if (!daily.ok) return daily;
  const worked = daily.data.filter((day) => day.status === "present" || day.status === "half_day");
  if (worked.length === 0) return ok([]);

  const members = await db
    .select({ id: userOrganizationsTable.id, userId: userOrganizationsTable.userId, branchId: userOrganizationsTable.branchId })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        inArray(userOrganizationsTable.userId, [...new Set(worked.map((day) => day.employeeId))]),
      ),
    );
  const membershipOf = new Map(members.map((member) => [member.userId, member.id]));
  const [offDay, rows] = await Promise.all([
    loadOffDays(organizationId, query.from, query.to, members),
    db
      .select()
      .from(offDayWork)
      .where(
        and(
          eq(offDayWork.organizationId, organizationId),
          inArray(offDayWork.userOrganizationId, members.map((member) => member.id)),
          gte(offDayWork.workDate, query.from),
          lte(offDayWork.workDate, query.to),
        ),
      ),
  ]);
  const rowOf = new Map(rows.map((row) => [`${row.userOrganizationId}|${row.workDate}`, row]));

  return ok(
    worked.flatMap((day): WorkedOffDay[] => {
      const membershipId = membershipOf.get(day.employeeId);
      if (!membershipId) return [];
      const { holiday, weeklyOff } = offDay(membershipId, day.date);
      if (!holiday && !weeklyOff) return [];
      const row = rowOf.get(`${membershipId}|${day.date}`);
      return [
        {
          employeeId: day.employeeId,
          employeeName: day.employeeName,
          membershipId,
          date: day.date,
          kind: holiday ? "holiday" : "weekly_off",
          days: day.status === "half_day" ? 0.5 : 1,
          workedMinutes: day.workedMinutes,
          requestedOutcome: row?.requestedOutcome ?? null,
          outcome: row?.outcome ?? null,
          automatic: !!row?.outcome && !row.decidedByUserId,
        },
      ];
    }),
  );
};

const todayAt = (utcOffsetMinutes: number) => new Date(Date.now() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);

/** Managers see everyone they manage; employees (or `mine`) see their own. Newest first. */
export const listOffDayWork = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof offDayWorkQuerySchema>,
) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const own = query.mine || !PEOPLE_MANAGER_ROLES.includes(access.data.role);
  const today = todayAt(query.utcOffsetMinutes);
  const result = await workedOffDays(organizationId, requesterId, {
    from: addDays(today, -LOOKBACK_DAYS),
    to: today,
    utcOffsetMinutes: query.utcOffsetMinutes,
    employeeId: own ? requesterId : undefined,
  });
  if (!result.ok) return result;
  return ok(result.data.sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName)));
};

const findWorkedDay = async (organizationId: string, requesterId: string, employeeId: string, date: string, utcOffsetMinutes: number) => {
  const result = await workedOffDays(organizationId, requesterId, { from: date, to: date, employeeId, utcOffsetMinutes });
  if (!result.ok) return result;
  const day = result.data[0];
  return day ? ok(day) : fail("invalid", "There is no completed work on a weekly off or holiday on that date");
};

/** An employee asks for comp-off or pay for a worked off-day; a manager decides. */
export const requestOffDayOutcome = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof requestOffDayOutcomeSchema>,
) => {
  const found = await findWorkedDay(organizationId, requesterId, requesterId, input.date, input.utcOffsetMinutes);
  if (!found.ok) return found;
  if (found.data.outcome) return fail("conflict", "This day has already been decided");
  await db
    .insert(offDayWork)
    .values({
      organizationId,
      userOrganizationId: found.data.membershipId,
      workDate: input.date,
      requestedOutcome: input.outcome,
      requestedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [offDayWork.userOrganizationId, offDayWork.workDate],
      set: { requestedOutcome: input.outcome, requestedAt: new Date() },
    });
  await notify({
    organizationId,
    userIds: await peopleManagerIds(organizationId, requesterId),
    type: "off_day_requested",
    title: `${found.data.employeeName} asked for ${input.outcome === "pay" ? "pay" : "comp-off"} for ${input.date}`,
    body: `They worked on a ${found.data.kind === "holiday" ? "holiday" : "weekly off"}.`,
    link: "/leave",
  });
  return ok({ date: input.date, requestedOutcome: input.outcome });
};

/** A payroll run already paid (or chose not to pay) this day; changing it now would not reach the salary. */
const finalizedPayrollCovers = async (organizationId: string, membershipId: string, date: string) => {
  const [row] = await db
    .select({ id: payrollItemsTable.id })
    .from(payrollItemsTable)
    .innerJoin(payrollRunsTable, eq(payrollRunsTable.id, payrollItemsTable.runId))
    .where(
      and(
        eq(payrollItemsTable.organizationId, organizationId),
        eq(payrollItemsTable.userOrganizationId, membershipId),
        eq(payrollRunsTable.status, "finalized"),
        lte(payrollRunsTable.periodStart, date),
        gte(payrollRunsTable.periodEnd, date),
      ),
    )
    .limit(1);
  return !!row;
};

const compOffTypeId = async (organizationId: string, requested?: string) => {
  const [type] = await db
    .select({ id: types.id, name: types.name })
    .from(types)
    .where(
      and(
        eq(types.organizationId, organizationId),
        eq(types.isActive, true),
        eq(types.isCompOff, true),
        requested ? eq(types.id, requested) : undefined,
      ),
    )
    .orderBy(asc(types.createdAt))
    .limit(1);
  return type ?? null;
};

/** Credits comp-off for one worked day (once), returning the credit's id. */
const creditCompOff = async (
  organizationId: string,
  membershipId: string,
  leaveTypeId: string,
  date: string,
  days: number,
  grantedByUserId: string | null,
) => {
  const [created] = await db
    .insert(credits)
    .values({
      organizationId,
      userOrganizationId: membershipId,
      leaveTypeId,
      workedOn: date,
      days: days.toFixed(1),
      reason: "Worked on an off day",
      grantedByUserId,
    })
    .onConflictDoNothing()
    .returning({ id: credits.id });
  if (created) return created.id;
  const [existing] = await db
    .select({ id: credits.id })
    .from(credits)
    .where(and(eq(credits.userOrganizationId, membershipId), eq(credits.leaveTypeId, leaveTypeId), eq(credits.workedOn, date)))
    .limit(1);
  return existing.id;
};

/** A manager settles a worked off-day: comp-off credit, pay in the next payroll, or nothing. */
export const decideOffDayWork = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof decideOffDayWorkSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const membership = await getEmployeeMembership(organizationId, input.employeeId);
  if (!membership) return fail("not-found", "Employee not found in this organization");
  if (!canManageMember(access.data, membership)) return fail("forbidden");

  const found = await findWorkedDay(organizationId, requesterId, input.employeeId, input.date, input.utcOffsetMinutes);
  if (!found.ok) return found;
  if (await finalizedPayrollCovers(organizationId, membership.id, input.date)) {
    return fail("conflict", "Payroll for this date is finalized, so this day can no longer be changed");
  }

  let leaveCreditId: string | null = null;
  if (input.outcome === "comp_off") {
    const type = await compOffTypeId(organizationId, input.leaveTypeId);
    if (!type) return fail("invalid", "Add an active leave type of kind \"Compensatory off\" first");
    leaveCreditId = await creditCompOff(organizationId, membership.id, type.id, input.date, found.data.days, requesterId);
  }
  // Switching away from comp-off takes the credit back.
  const [previous] = await db
    .select({ leaveCreditId: offDayWork.leaveCreditId })
    .from(offDayWork)
    .where(and(eq(offDayWork.userOrganizationId, membership.id), eq(offDayWork.workDate, input.date)))
    .limit(1);
  if (previous?.leaveCreditId && previous.leaveCreditId !== leaveCreditId) {
    await db.delete(credits).where(eq(credits.id, previous.leaveCreditId));
  }

  const decided = { outcome: input.outcome, decidedByUserId: requesterId, decidedAt: new Date(), leaveCreditId };
  await db
    .insert(offDayWork)
    .values({ organizationId, userOrganizationId: membership.id, workDate: input.date, ...decided })
    .onConflictDoUpdate({ target: [offDayWork.userOrganizationId, offDayWork.workDate], set: decided });

  const what = { comp_off: "comp-off credited", pay: "will be paid with your salary", none: "not compensated" }[input.outcome];
  await notify({
    organizationId,
    userIds: [input.employeeId],
    type: "off_day_decided",
    title: `Work on ${input.date}: ${what}`,
    link: input.outcome === "comp_off" ? "/leave" : "/attendance/my",
  });
  return ok({ date: input.date, outcome: input.outcome });
};

/**
 * Under the "always comp-off" policy, payroll credits each undecided worked off-day.
 * Returns false when the organization has no comp-off leave type, leaving the days undecided.
 */
export const autoCreditCompOff = async (organizationId: string, membershipId: string, days: { date: string; days: number }[]) => {
  const type = await compOffTypeId(organizationId);
  if (!type) return false;
  for (const day of days) {
    const leaveCreditId = await creditCompOff(organizationId, membershipId, type.id, day.date, day.days, null);
    await db
      .insert(offDayWork)
      .values({ organizationId, userOrganizationId: membershipId, workDate: day.date, outcome: "comp_off", leaveCreditId })
      .onConflictDoNothing();
  }
  return true;
};

/** Decided off-day outcomes in a period, by membership and date, for payroll. */
export const offDayOutcomesBetween = async (organizationId: string, from: string, to: string) => {
  const rows = await db
    .select({ membershipId: offDayWork.userOrganizationId, date: offDayWork.workDate, outcome: offDayWork.outcome })
    .from(offDayWork)
    .where(and(eq(offDayWork.organizationId, organizationId), gte(offDayWork.workDate, from), lte(offDayWork.workDate, to)));
  const byMembership = new Map<string, Map<string, OffDayOutcome>>();
  for (const row of rows) {
    if (!row.outcome) continue;
    const dates = byMembership.get(row.membershipId) ?? new Map<string, OffDayOutcome>();
    dates.set(row.date, row.outcome);
    byMembership.set(row.membershipId, dates);
  }
  return byMembership;
};

export const listLeaveCredits = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof leaveCreditQuerySchema>,
) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);
  const employeeId = isManager ? query.employeeId : requesterId;
  const branchIds = isManager && !employeeId ? branchFilter(access.data, undefined) : undefined;
  const rows = await db
    .select({
      id: credits.id,
      employeeId: userOrganizationsTable.userId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      leaveTypeId: credits.leaveTypeId,
      leaveTypeName: types.name,
      workedOn: credits.workedOn,
      days: credits.days,
      reason: credits.reason,
      createdAt: credits.createdAt,
    })
    .from(credits)
    .innerJoin(userOrganizationsTable, eq(userOrganizationsTable.id, credits.userOrganizationId))
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .innerJoin(types, eq(types.id, credits.leaveTypeId))
    .where(
      and(
        eq(credits.organizationId, organizationId),
        employeeId ? eq(userOrganizationsTable.userId, employeeId) : undefined,
        branchIds ? inArray(userOrganizationsTable.branchId, branchIds) : undefined,
      ),
    )
    .orderBy(desc(credits.workedOn))
    .limit(200);
  return ok(rows.map(({ fname, lname, ...row }) => ({ ...row, employeeName: `${fname} ${lname}`.trim() })));
};

/** Removes a comp-off credit; the worked day it came from goes back to undecided. */
export const revokeLeaveCredit = async (organizationId: string, requesterId: string, creditId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const [credit] = await db
    .select({ id: credits.id, role: userOrganizationsTable.role, branchId: userOrganizationsTable.branchId })
    .from(credits)
    .innerJoin(userOrganizationsTable, eq(userOrganizationsTable.id, credits.userOrganizationId))
    .where(and(eq(credits.id, creditId), eq(credits.organizationId, organizationId)))
    .limit(1);
  if (!credit) return fail("not-found", "Credit not found");
  if (!canManageMember(access.data, credit)) return fail("forbidden");
  await db
    .update(offDayWork)
    .set({ outcome: null, decidedByUserId: null, decidedAt: null, leaveCreditId: null })
    .where(eq(offDayWork.leaveCreditId, creditId));
  await db.delete(credits).where(eq(credits.id, creditId));
  return ok({ id: creditId });
};
