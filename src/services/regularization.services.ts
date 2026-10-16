import { and, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  attendanceRegularizationsTable as requests,
  leaveRequestsTable,
  userOrganizationsTable,
  usersTable,
  UserRole,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  canManageMember,
  getEmployeeMembership,
  PEOPLE_MANAGER_ROLES,
  requireRole,
} from "@/services/access.services";
import { insertAttendance } from "@/services/attendance.services";
import { peopleManagerIds, notify } from "@/services/notification.services";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  createRegularizationSchema,
  listRegularizationQuerySchema,
  updateRegularizationStatusSchema,
} from "@/validator/regularization.validator";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_BACKDATE_DAYS = 31;

const selectRequests = (where: SQL | undefined) =>
  db
    .select({
      id: requests.id,
      employeeId: userOrganizationsTable.userId,
      employeeRole: userOrganizationsTable.role,
      employeeBranchId: userOrganizationsTable.branchId,
      fname: usersTable.fname,
      lname: usersTable.lname,
      date: requests.date,
      requestedCheckIn: requests.requestedCheckIn,
      requestedCheckOut: requests.requestedCheckOut,
      reason: requests.reason,
      status: requests.status,
      reviewedAt: requests.reviewedAt,
      reviewNote: requests.reviewNote,
      createdAt: requests.createdAt,
    })
    .from(requests)
    .innerJoin(userOrganizationsTable, eq(userOrganizationsTable.id, requests.userOrganizationId))
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .where(where);

type Row = Awaited<ReturnType<typeof selectRequests>>[number];

const toRequest = ({ fname, lname, ...row }: Row) => ({
  ...row,
  employeeName: `${fname} ${lname}`.trim(),
});

type Regularization = ReturnType<typeof toRequest>;

const loadOne = async (organizationId: string, id: string) => {
  const [row] = await selectRequests(
    and(eq(requests.organizationId, organizationId), eq(requests.id, id)),
  ).limit(1);
  return row ? toRequest(row) : null;
};

const toInstant = (date: string, time: string, offsetMinutes: number) =>
  new Date(Date.parse(`${date}T${time}:00Z`) - offsetMinutes * MINUTE_MS);

export const createRegularization = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createRegularizationSchema>,
): Promise<ServiceResult<Regularization>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const membership = await getEmployeeMembership(organizationId, requesterId);
  if (!membership || !membership.isActive) return fail("not-found", "Employee not found");

  const today = new Date(Date.now() + input.utcOffsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
  const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - MAX_BACKDATE_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  if (input.date > today) return fail("invalid", "You cannot regularize a future date");
  if (input.date < earliest) {
    return fail("invalid", `Only the last ${MAX_BACKDATE_DAYS} days can be regularized`);
  }

  const checkIn = input.checkIn ? toInstant(input.date, input.checkIn, input.utcOffsetMinutes) : null;
  const checkOut = input.checkOut ? toInstant(input.date, input.checkOut, input.utcOffsetMinutes) : null;
  if ([checkIn, checkOut].some((value) => value && value.getTime() > Date.now())) {
    return fail("invalid", "Punch time cannot be in the future");
  }

  const [pending] = await db
    .select({ id: requests.id })
    .from(requests)
    .where(
      and(
        eq(requests.userOrganizationId, membership.id),
        eq(requests.date, input.date),
        eq(requests.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) return fail("conflict", "You already have a pending request for this date");

  const [leave] = await db
    .select({ id: leaveRequestsTable.id })
    .from(leaveRequestsTable)
    .where(
      and(
        eq(leaveRequestsTable.userOrganizationId, membership.id),
        eq(leaveRequestsTable.status, "approved"),
        eq(leaveRequestsTable.isHalfDay, false),
        lte(leaveRequestsTable.startDate, input.date),
        gte(leaveRequestsTable.endDate, input.date),
      ),
    )
    .limit(1);
  if (leave) return fail("conflict", "You are on approved leave on that date");

  const [created] = await db
    .insert(requests)
    .values({
      organizationId,
      userOrganizationId: membership.id,
      date: input.date,
      requestedCheckIn: checkIn,
      requestedCheckOut: checkOut,
      reason: input.reason,
    })
    .returning({ id: requests.id });
  const request = await loadOne(organizationId, created.id);
  if (!request) return fail("not-found");

  await notify({
    organizationId,
    userIds: await peopleManagerIds(organizationId, requesterId),
    type: "regularization_requested",
    title: `${request.employeeName} requested an attendance correction`,
    body: `${request.date}: ${input.reason}`,
    link: "/attendance/regularization",
  });
  return ok(request);
};

export const listRegularizations = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof listRegularizationQuerySchema>,
): Promise<ServiceResult<Regularization[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);

  const conditions: SQL[] = [eq(requests.organizationId, organizationId)];
  if (!isManager || query.mine === "true") conditions.push(eq(userOrganizationsTable.userId, requesterId));
  if (access.data.role === UserRole.HR && query.mine !== "true") {
    conditions.push(eq(userOrganizationsTable.role, UserRole.EMPLOYEE));
  }
  if (isManager && query.mine !== "true" && access.data.branchIds) {
    conditions.push(inArray(userOrganizationsTable.branchId, access.data.branchIds));
  }
  if (query.status) conditions.push(eq(requests.status, query.status));

  const rows = await selectRequests(and(...conditions))
    .orderBy(desc(requests.createdAt))
    .limit(200);
  return ok(rows.map(toRequest));
};

export const updateRegularizationStatus = async (
  organizationId: string,
  requesterId: string,
  requestId: string,
  input: z.infer<typeof updateRegularizationStatusSchema>,
): Promise<ServiceResult<Regularization>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const current = await loadOne(organizationId, requestId);
  if (!current) return fail("not-found", "Request not found");

  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role);
  const isOwn = current.employeeId === requesterId;
  const isOwnCancel = input.status === "cancelled" && isOwn;

  if (
    isManager &&
    !isOwnCancel &&
    !canManageMember(access.data, { role: current.employeeRole, branchId: current.employeeBranchId })
  ) {
    return fail("forbidden");
  }

  if (!isManager && !isOwnCancel) {
    return isOwn ? fail("forbidden") : fail("not-found", "Request not found");
  }
  if (!isOwnCancel) {
    const isSuper = access.data.role === UserRole.SUPER_ADMIN;
    if (isOwn && !isSuper) return fail("forbidden", "You cannot review your own request");
    if (!isSuper && current.employeeRole === UserRole.SUPER_ADMIN) return fail("forbidden");
  }
  if (current.status !== "pending") {
    return fail("conflict", `Request is already ${current.status}`);
  }

  const now = new Date();
  const [updated] = await db
    .update(requests)
    .set({
      status: input.status,
      updatedAt: now,
      ...(isOwnCancel
        ? {}
        : { reviewedByUserId: requesterId, reviewedAt: now, reviewNote: input.reviewNote }),
    })
    .where(
      and(
        eq(requests.id, requestId),
        eq(requests.organizationId, organizationId),
        eq(requests.status, "pending"),
      ),
    )
    .returning({ userOrganizationId: requests.userOrganizationId });
  if (!updated) return fail("conflict", "Status was changed by someone else; reload and retry");

  if (input.status === "approved") {
    const punches = [
      { eventType: "check_in" as const, at: current.requestedCheckIn },
      { eventType: "check_out" as const, at: current.requestedCheckOut },
    ];
    for (const punch of punches) {
      if (!punch.at) continue;
      await insertAttendance({
        organizationId,
        userOrganizationId: updated.userOrganizationId,
        source: "regularization",
        eventType: punch.eventType,
        occurredAt: punch.at.toISOString(),
      });
    }
  }

  const request = await loadOne(organizationId, requestId);
  if (!request) return fail("not-found");

  if (isOwnCancel) {
    await notify({
      organizationId,
      userIds: await peopleManagerIds(organizationId, requesterId),
      type: "regularization_cancelled",
      title: `${request.employeeName} cancelled an attendance correction`,
      body: request.date,
      link: "/attendance/regularization",
    });
  } else if (!isOwn) {
    await notify({
      organizationId,
      userIds: [request.employeeId],
      type: `regularization_${input.status}`,
      title: `Your attendance correction was ${input.status}`,
      body: [request.date, input.reviewNote].filter(Boolean).join(" — "),
      link: "/attendance/my",
    });
  }
  return ok(request);
};
