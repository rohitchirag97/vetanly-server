import { and, desc, eq, inArray, lte, gte, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  leaveCreditsTable as credits,
  leaveRequestsTable as requests,
  leaveTypesTable as types,
  userOrganizationsTable,
  usersTable,
  UserRole,
  type LeaveStatus,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  branchFilter,
  canManageMember,
  getEmployeeMembership,
  PEOPLE_MANAGER_ROLES,
  requireRole,
} from "@/services/access.services";
import { carriedInto, compOffAvailable } from "@/services/leave-balance";
import { peopleManagerIds, notify } from "@/services/notification.services";
import { fail, isUniqueViolation, ok, type ServiceResult } from "@/utils/result";
import type {
  createLeaveRequestSchema,
  createLeaveTypeSchema,
  listLeaveQuerySchema,
  updateLeaveStatusSchema,
  updateLeaveTypeSchema,
} from "@/validator/leave.validator";

const typeColumns = {
  id: types.id,
  name: types.name,
  isPaid: types.isPaid,
  annualAllowanceDays: types.annualAllowanceDays,
  carryForwardMaxDays: types.carryForwardMaxDays,
  isCompOff: types.isCompOff,
  compOffValidityDays: types.compOffValidityDays,
  isActive: types.isActive,
  createdAt: types.createdAt,
};

type LeaveTypeRow = {
  id: string;
  annualAllowanceDays: string | null;
  carryForwardMaxDays: string | null;
  isCompOff: boolean;
  compOffValidityDays: number | null;
  createdAt: Date;
};

// A comp-off type has no yearly allowance or carry-forward: its days come only from credits.
const typeRules = (input: { isCompOff?: boolean; annualAllowanceDays?: number | null; carryForwardMaxDays?: number | null }) =>
  input.isCompOff
    ? { annualAllowanceDays: null, carryForwardMaxDays: null }
    : {
        annualAllowanceDays:
          input.annualAllowanceDays === undefined || input.annualAllowanceDays === null
            ? input.annualAllowanceDays
            : input.annualAllowanceDays.toFixed(1),
        carryForwardMaxDays:
          input.carryForwardMaxDays === undefined || input.carryForwardMaxDays === null
            ? input.carryForwardMaxDays
            : input.carryForwardMaxDays.toFixed(1),
      };

const transitions: Record<string, LeaveStatus[]> = {
  pending: ["approved", "rejected", "cancelled"],
  approved: ["cancelled"],
};

const toUtcDay = (date: string) => Date.parse(`${date}T00:00:00Z`);

const countDays = (start: string, end: string, isHalfDay: boolean) =>
  isHalfDay ? 0.5 : (toUtcDay(end) - toUtcDay(start)) / 86_400_000 + 1;

export const listLeaveTypes = async (
  organizationId: string,
  requesterId: string,
) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);
  return ok(
    await db
      .select(typeColumns)
      .from(types)
      .where(
        and(
          eq(types.organizationId, organizationId),
          isManager ? undefined : eq(types.isActive, true),
        ),
      )
      .orderBy(types.name),
  );
};

export const createLeaveType = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createLeaveTypeSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  try {
    const [created] = await db
      .insert(types)
      .values({
        organizationId,
        name: input.name,
        isPaid: input.isPaid,
        isCompOff: input.isCompOff,
        compOffValidityDays: input.isCompOff ? input.compOffValidityDays : null,
        ...typeRules(input),
      })
      .returning(typeColumns);
    return ok(created);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", "A leave type with this name already exists");
    throw error;
  }
};

export const updateLeaveType = async (
  organizationId: string,
  requesterId: string,
  typeId: string,
  input: z.infer<typeof updateLeaveTypeSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  try {
    const [updated] = await db
      .update(types)
      .set({ ...input, ...typeRules(input) })
      .where(and(eq(types.id, typeId), eq(types.organizationId, organizationId)))
      .returning(typeColumns);
    return updated ? ok(updated) : fail("not-found", "Leave type not found");
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", "A leave type with this name already exists");
    throw error;
  }
};

const selectRequests = (where: SQL | undefined) =>
  db
    .select({
      id: requests.id,
      employeeId: userOrganizationsTable.userId,
      employeeRole: userOrganizationsTable.role,
      employeeBranchId: userOrganizationsTable.branchId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      leaveTypeId: requests.leaveTypeId,
      leaveTypeName: types.name,
      isPaid: types.isPaid,
      startDate: requests.startDate,
      endDate: requests.endDate,
      isHalfDay: requests.isHalfDay,
      days: requests.days,
      reason: requests.reason,
      status: requests.status,
      reviewedAt: requests.reviewedAt,
      reviewNote: requests.reviewNote,
      createdAt: requests.createdAt,
    })
    .from(requests)
    .innerJoin(
      userOrganizationsTable,
      eq(userOrganizationsTable.id, requests.userOrganizationId),
    )
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .innerJoin(types, eq(types.id, requests.leaveTypeId))
    .where(where);

type Row = Awaited<ReturnType<typeof selectRequests>>[number];

const toRequest = ({ fname, lname, ...row }: Row) => ({
  ...row,
  employeeName: `${fname} ${lname}`.trim(),
});

type LeaveRequest = ReturnType<typeof toRequest>;

const loadOne = async (organizationId: string, id: string) => {
  const [row] = await selectRequests(
    and(eq(requests.organizationId, organizationId), eq(requests.id, id)),
  ).limit(1);
  return row ? toRequest(row) : null;
};

const sumByYear = (rows: { date: string; days: string }[]) => {
  const byYear = new Map<number, number>();
  for (const row of rows) {
    const year = Number(row.date.slice(0, 4));
    byYear.set(year, (byYear.get(year) ?? 0) + Number(row.days));
  }
  return byYear;
};

/**
 * One employee's balance of one leave type as of a date (see leave-balance.ts). Pending requests
 * count as used so two open requests cannot spend the same days.
 */
export const leaveTypeBalance = async (membershipId: string, type: LeaveTypeRow, asOf: string) => {
  const [taken, granted, [member]] = await Promise.all([
    db
      .select({ date: requests.startDate, days: requests.days })
      .from(requests)
      .where(
        and(
          eq(requests.userOrganizationId, membershipId),
          eq(requests.leaveTypeId, type.id),
          inArray(requests.status, ["pending", "approved"]),
        ),
      ),
    db
      .select({ date: credits.workedOn, days: credits.days })
      .from(credits)
      .where(and(eq(credits.userOrganizationId, membershipId), eq(credits.leaveTypeId, type.id))),
    db
      .select({ hireDate: userOrganizationsTable.hireDate })
      .from(userOrganizationsTable)
      .where(eq(userOrganizationsTable.id, membershipId))
      .limit(1),
  ]);
  const year = Number(asOf.slice(0, 4));
  const usedByYear = sumByYear(taken);
  const creditsByYear = sumByYear(granted);
  const used = usedByYear.get(year) ?? 0;
  const credited = creditsByYear.get(year) ?? 0;

  if (type.isCompOff) {
    const remaining = compOffAvailable({
      credits: granted.map((row) => ({ workedOn: row.date, days: Number(row.days) })),
      taken: taken.map((row) => ({ startDate: row.date, days: Number(row.days) })),
      asOf,
      validityDays: type.compOffValidityDays,
    });
    return { allowance: null, carried: 0, credited, used, remaining };
  }
  if (type.annualAllowanceDays === null) return { allowance: null, carried: 0, credited, used, remaining: null };

  const allowance = Number(type.annualAllowanceDays);
  // Carrying starts from the later of the year they joined and the year the leave type was created.
  const joinedYear = member?.hireDate ? Number(member.hireDate.slice(0, 4)) : 0;
  const firstYear = Math.max(type.createdAt.getUTCFullYear(), joinedYear);
  const carried = carriedInto({
    year,
    firstYear,
    allowance,
    cap: type.carryForwardMaxDays === null ? null : Number(type.carryForwardMaxDays),
    usedByYear,
    creditsByYear,
  });
  return { allowance, carried, credited, used, remaining: Math.max(0, allowance + carried + credited - used) };
};

export const createLeaveRequest = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createLeaveRequestSchema>,
): Promise<ServiceResult<LeaveRequest>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);
  if (!isManager && input.employeeId && input.employeeId !== requesterId) {
    return fail("forbidden");
  }
  const employeeId = isManager ? (input.employeeId ?? requesterId) : requesterId;
  const membership = await getEmployeeMembership(organizationId, employeeId);
  if (!membership || !membership.isActive) {
    return fail("not-found", "Employee not found in this organization");
  }
  if (employeeId !== requesterId && !canManageMember(access.data, membership)) {
    return fail("forbidden");
  }

  const [type] = await db
    .select(typeColumns)
    .from(types)
    .where(
      and(
        eq(types.id, input.leaveTypeId),
        eq(types.organizationId, organizationId),
        eq(types.isActive, true),
      ),
    )
    .limit(1);
  if (!type) return fail("invalid", "Leave type is not available");

  const [overlap] = await db
    .select({ id: requests.id })
    .from(requests)
    .where(
      and(
        eq(requests.userOrganizationId, membership.id),
        inArray(requests.status, ["pending", "approved"]),
        lte(requests.startDate, input.endDate),
        gte(requests.endDate, input.startDate),
      ),
    )
    .limit(1);
  if (overlap) return fail("conflict", "You already have leave in this date range");

  const days = countDays(input.startDate, input.endDate, input.isHalfDay);
  const balance = await leaveTypeBalance(membership.id, type, input.startDate);
  if (balance.remaining !== null && days > balance.remaining) {
    return fail(
      "invalid",
      type.isCompOff
        ? `Only ${balance.remaining} comp-off day(s) are available on that date`
        : `This request exceeds the ${balance.remaining} day(s) left of this leave type this year`,
    );
  }

  const [created] = await db
    .insert(requests)
    .values({
      organizationId,
      userOrganizationId: membership.id,
      leaveTypeId: type.id,
      startDate: input.startDate,
      endDate: input.endDate,
      isHalfDay: input.isHalfDay,
      days: days.toFixed(1),
      reason: input.reason,
    })
    .returning({ id: requests.id });
  const request = await loadOne(organizationId, created.id);
  if (!request) return fail("not-found");

  const range =
    request.startDate === request.endDate
      ? request.startDate
      : `${request.startDate} to ${request.endDate}`;
  if (employeeId !== requesterId) {
    await notify({
      organizationId,
      userIds: [employeeId],
      type: "leave_requested",
      title: "Leave was applied for you",
      body: `${request.leaveTypeName}, ${range}`,
      link: "/leave",
    });
  }
  await notify({
    organizationId,
    userIds: await peopleManagerIds(organizationId, requesterId),
    type: "leave_requested",
    title: `${request.employeeName} requested leave`,
    body: `${request.leaveTypeName}, ${range} (${request.days} day${Number(request.days) === 1 ? "" : "s"})`,
    link: "/leave/applications",
  });
  return ok(request);
};

export const listLeaveRequests = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof listLeaveQuerySchema>,
): Promise<ServiceResult<LeaveRequest[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);
  if (!isManager && query.employeeId && query.employeeId !== requesterId) {
    return fail("forbidden");
  }
  const employeeId = isManager ? query.employeeId : requesterId;

  const conditions: SQL[] = [eq(requests.organizationId, organizationId)];
  if (employeeId) conditions.push(eq(userOrganizationsTable.userId, employeeId));
  if (access.data.role === UserRole.HR) {
    conditions.push(
      eq(
        userOrganizationsTable.role,
        employeeId === requesterId ? UserRole.HR : UserRole.EMPLOYEE,
      ),
    );
  }
  const branchIds = isManager && employeeId !== requesterId ? branchFilter(access.data, query.branchId) : undefined;
  if (branchIds) conditions.push(inArray(userOrganizationsTable.branchId, branchIds));
  if (query.status) conditions.push(eq(requests.status, query.status));

  const rows = await selectRequests(and(...conditions)).orderBy(desc(requests.createdAt));
  return ok(rows.map(toRequest));
};

export const updateLeaveStatus = async (
  organizationId: string,
  requesterId: string,
  requestId: string,
  input: z.infer<typeof updateLeaveStatusSchema>,
): Promise<ServiceResult<LeaveRequest>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const current = await loadOne(organizationId, requestId);
  if (!current) return fail("not-found", "Leave request not found");

  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);
  const isOwn = current.employeeId === requesterId;
  const isOwnPendingCancel =
    input.status === "cancelled" && current.status === "pending" && isOwn;

  if (
    isManager &&
    !isOwnPendingCancel &&
    !canManageMember(access.data, { role: current.employeeRole, branchId: current.employeeBranchId })
  ) {
    return fail("forbidden");
  }

  if (!isManager && !isOwnPendingCancel) {
    return isOwn ? fail("forbidden") : fail("not-found", "Leave request not found");
  }
  if (input.status !== "cancelled" || !isOwn) {
    if (isManager) {
      const isSuper = access.data.role === UserRole.SUPER_ADMIN;
      if (isOwn && !isSuper) return fail("forbidden", "You cannot review your own request");
      if (!isSuper && current.employeeRole === UserRole.SUPER_ADMIN) return fail("forbidden");
    }
  }
  if (!transitions[current.status]?.includes(input.status)) {
    return fail("conflict", `Cannot change status from ${current.status} to ${input.status}`);
  }

  const now = new Date();
  const [updated] = await db
    .update(requests)
    .set({
      status: input.status,
      updatedAt: now,
      ...(input.status !== "cancelled" || isManager
        ? { reviewedByUserId: requesterId, reviewedAt: now, reviewNote: input.reviewNote }
        : {}),
    })
    .where(
      and(
        eq(requests.id, requestId),
        eq(requests.organizationId, organizationId),
        eq(requests.status, current.status),
      ),
    )
    .returning({ id: requests.id });
  if (!updated) return fail("conflict", "Status was changed by someone else; reload and retry");

  const request = await loadOne(organizationId, requestId);
  if (!request) return fail("not-found");

  const verdict = input.status;
  if (!isOwn) {
    await notify({
      organizationId,
      userIds: [request.employeeId],
      type: `leave_${input.status}`,
      title: `Your leave was ${verdict}`,
      body: [`${request.leaveTypeName}, ${request.startDate} to ${request.endDate}`, input.reviewNote]
        .filter(Boolean)
        .join(" — "),
      link: "/leave",
    });
  } else {
    await notify({
      organizationId,
      userIds: await peopleManagerIds(organizationId, requesterId),
      type: "leave_cancelled",
      title: `${request.employeeName} cancelled a leave request`,
      body: `${request.leaveTypeName}, ${request.startDate} to ${request.endDate}`,
      link: "/leave/applications",
    });
  }
  return ok(request);
};

export const getLeaveBalances = async (
  organizationId: string,
  requesterId: string,
  year: number,
) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const activeTypes = await db
    .select(typeColumns)
    .from(types)
    .where(and(eq(types.organizationId, organizationId), eq(types.isActive, true)))
    .orderBy(types.name);
  const today = new Date().toISOString().slice(0, 10);
  // Comp-off is counted as of today (credits expire); yearly types as of the year asked for.
  const asOfFor = (isCompOff: boolean) => (isCompOff || today.startsWith(String(year)) ? today : `${year}-12-31`);
  const balances = [];
  for (const type of activeTypes) {
    const balance = await leaveTypeBalance(access.data.id, type, asOfFor(type.isCompOff));
    balances.push({
      leaveTypeId: type.id,
      name: type.name,
      isCompOff: type.isCompOff,
      allowanceDays: balance.allowance,
      carriedForwardDays: balance.carried,
      creditedDays: balance.credited,
      usedDays: balance.used,
      remainingDays: balance.remaining,
    });
  }
  return ok(balances);
};

/** Unused paid leave on the last working day (carried-forward and comp-off days included), for encashment in a final settlement. */
export const remainingPaidLeave = async (organizationId: string, membershipId: string, asOf: string) => {
  const paidTypes = await db
    .select(typeColumns)
    .from(types)
    .where(and(eq(types.organizationId, organizationId), eq(types.isActive, true), eq(types.isPaid, true)));
  const result: { name: string; remainingDays: number }[] = [];
  for (const type of paidTypes) {
    const { remaining } = await leaveTypeBalance(membershipId, type, asOf);
    if (remaining !== null) result.push({ name: type.name, remainingDays: remaining });
  }
  return result;
};
