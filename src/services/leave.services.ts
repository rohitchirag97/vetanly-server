import { and, desc, eq, inArray, lte, gte, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  leaveRequestsTable as requests,
  leaveTypesTable as types,
  userOrganizationsTable,
  usersTable,
  UserRole,
  type LeaveStatus,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  getEmployeeMembership,
  PEOPLE_MANAGER_ROLES,
  requireRole,
} from "@/services/access.services";
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
  isActive: types.isActive,
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
        annualAllowanceDays: input.annualAllowanceDays?.toFixed(1),
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
      .set({
        ...input,
        annualAllowanceDays:
          input.annualAllowanceDays === undefined || input.annualAllowanceDays === null
            ? input.annualAllowanceDays
            : input.annualAllowanceDays.toFixed(1),
      })
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

const usedDays = async (userOrganizationId: string, leaveTypeId: string, year: number) => {
  const rows = await db
    .select({ days: requests.days })
    .from(requests)
    .where(
      and(
        eq(requests.userOrganizationId, userOrganizationId),
        eq(requests.leaveTypeId, leaveTypeId),
        inArray(requests.status, ["pending", "approved"]),
        gte(requests.startDate, `${year}-01-01`),
        lte(requests.startDate, `${year}-12-31`),
      ),
    );
  return rows.reduce((sum, row) => sum + Number(row.days), 0);
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
  if (
    access.data.role === UserRole.HR &&
    membership.role !== UserRole.EMPLOYEE &&
    employeeId !== requesterId
  ) {
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
  if (type.annualAllowanceDays !== null) {
    const used = await usedDays(membership.id, type.id, Number(input.startDate.slice(0, 4)));
    if (used + days > Number(type.annualAllowanceDays)) {
      return fail("invalid", "This request exceeds the annual allowance for this leave type");
    }
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
    access.data.role === UserRole.HR &&
    current.employeeRole !== UserRole.EMPLOYEE &&
    !isOwnPendingCancel
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
  const balances = [];
  for (const type of activeTypes) {
    const used = await usedDays(access.data.id, type.id, year);
    const allowance = type.annualAllowanceDays === null ? null : Number(type.annualAllowanceDays);
    balances.push({
      leaveTypeId: type.id,
      name: type.name,
      allowanceDays: allowance,
      usedDays: used,
      remainingDays: allowance === null ? null : Math.max(allowance - used, 0),
    });
  }
  return ok(balances);
};
