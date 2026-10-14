import { and, asc, count, eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  employeeExitsTable,
  employeeLifecycleTasksTable,
  userOrganizationsTable,
  UserRole,
  type LifecycleKind,
} from "@/drizzle/schema";
import { authorizeEmployeeRecord } from "@/services/access.services";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type { createTaskSchema, exitSchema } from "@/validator/employee-record.validator";

const MAX_TASKS_PER_KIND = 50;
const DAY_MS = 86_400_000;

const DEFAULT_TASKS: Record<LifecycleKind, string[]> = {
  onboarding: [
    "Collect ID and address proof",
    "Collect bank details",
    "Sign offer letter / contract",
    "Assign department and shift",
    "Set up salary and pay components",
    "Enroll face for attendance kiosk",
    "Orientation and equipment handover",
  ],
  offboarding: [
    "Accept resignation / issue notice",
    "Knowledge transfer and handover",
    "Return company assets and ID card",
    "Clear pending loans and advances",
    "Run final payroll and settlement",
    "Exit interview",
    "Issue relieving / experience letter",
  ],
};

const taskColumns = {
  id: employeeLifecycleTasksTable.id,
  kind: employeeLifecycleTasksTable.kind,
  title: employeeLifecycleTasksTable.title,
  isDone: employeeLifecycleTasksTable.isDone,
  doneAt: employeeLifecycleTasksTable.doneAt,
};

const exitColumns = {
  id: employeeExitsTable.id,
  exitType: employeeExitsTable.exitType,
  status: employeeExitsTable.status,
  resignationDate: employeeExitsTable.resignationDate,
  noticeDays: employeeExitsTable.noticeDays,
  lastWorkingDay: employeeExitsTable.lastWorkingDay,
  reason: employeeExitsTable.reason,
  notes: employeeExitsTable.notes,
  completedAt: employeeExitsTable.completedAt,
};

export type LifecycleTask = {
  id: string;
  kind: LifecycleKind;
  title: string;
  isDone: boolean;
  doneAt: Date | null;
};
export type EmployeeExit = {
  id: string;
  exitType: string;
  status: string;
  resignationDate: string;
  noticeDays: number;
  lastWorkingDay: string;
  reason: string | null;
  notes: string | null;
  completedAt: Date | null;
};

const taskScope = (organizationId: string, employeeId: string, kind: LifecycleKind) =>
  and(
    eq(employeeLifecycleTasksTable.organizationId, organizationId),
    eq(employeeLifecycleTasksTable.userId, employeeId),
    eq(employeeLifecycleTasksTable.kind, kind),
  );

const exitScope = (organizationId: string, employeeId: string) =>
  and(eq(employeeExitsTable.organizationId, organizationId), eq(employeeExitsTable.userId, employeeId));

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const insertDefaultTasks = (organizationId: string, employeeId: string, kind: LifecycleKind) =>
  db.insert(employeeLifecycleTasksTable).values(
    DEFAULT_TASKS[kind].map((title, sortOrder) => ({
      organizationId,
      userId: employeeId,
      kind,
      title,
      sortOrder,
    })),
  );

export const listLifecycleTasks = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  kind: LifecycleKind,
): Promise<ServiceResult<LifecycleTask[]>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;
  return ok(
    await db
      .select(taskColumns)
      .from(employeeLifecycleTasksTable)
      .where(taskScope(organizationId, employeeId, kind))
      .orderBy(asc(employeeLifecycleTasksTable.sortOrder), asc(employeeLifecycleTasksTable.createdAt)),
  );
};

export const startChecklist = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  kind: LifecycleKind,
): Promise<ServiceResult<LifecycleTask[]>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, false);
  if (!access.ok) return access;

  const [{ total }] = await db
    .select({ total: count() })
    .from(employeeLifecycleTasksTable)
    .where(taskScope(organizationId, employeeId, kind));
  if (total > 0) return fail("conflict", "This checklist has already been started");

  await insertDefaultTasks(organizationId, employeeId, kind);
  return listLifecycleTasks(organizationId, requesterId, employeeId, kind);
};

export const addLifecycleTask = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  input: z.infer<typeof createTaskSchema>,
): Promise<ServiceResult<LifecycleTask>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, false);
  if (!access.ok) return access;

  const [{ total }] = await db
    .select({ total: count() })
    .from(employeeLifecycleTasksTable)
    .where(taskScope(organizationId, employeeId, input.kind));
  if (total >= MAX_TASKS_PER_KIND) return fail("invalid", "Too many tasks in this checklist");

  const [task] = await db
    .insert(employeeLifecycleTasksTable)
    .values({
      organizationId,
      userId: employeeId,
      kind: input.kind,
      title: input.title,
      sortOrder: total,
    })
    .returning(taskColumns);
  return ok(task);
};

export const setLifecycleTaskDone = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  taskId: string,
  isDone: boolean,
): Promise<ServiceResult<LifecycleTask>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, false);
  if (!access.ok) return access;

  const [task] = await db
    .update(employeeLifecycleTasksTable)
    .set({ isDone, doneAt: isDone ? new Date() : null })
    .where(
      and(
        eq(employeeLifecycleTasksTable.id, taskId),
        eq(employeeLifecycleTasksTable.organizationId, organizationId),
        eq(employeeLifecycleTasksTable.userId, employeeId),
      ),
    )
    .returning(taskColumns);
  return task ? ok(task) : fail("not-found", "Task not found");
};

export const deleteLifecycleTask = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  taskId: string,
): Promise<ServiceResult<null>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, false);
  if (!access.ok) return access;

  const deleted = await db
    .delete(employeeLifecycleTasksTable)
    .where(
      and(
        eq(employeeLifecycleTasksTable.id, taskId),
        eq(employeeLifecycleTasksTable.organizationId, organizationId),
        eq(employeeLifecycleTasksTable.userId, employeeId),
      ),
    )
    .returning({ id: employeeLifecycleTasksTable.id });
  return deleted.length > 0 ? ok(null) : fail("not-found", "Task not found");
};

export const getEmployeeExit = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<ServiceResult<EmployeeExit | null>> => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;
  const [exit] = await db
    .select(exitColumns)
    .from(employeeExitsTable)
    .where(exitScope(organizationId, employeeId))
    .limit(1);
  return ok(exit ?? null);
};

const authorizeExitChange = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
) => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, false);
  if (!access.ok) return access;
  if (access.data.isSelf) return fail("forbidden", "Ask another admin to manage your own exit");
  if (access.data.target.role === UserRole.SUPER_ADMIN) {
    return fail("forbidden", "The super admin cannot be offboarded");
  }
  return access;
};

export const saveEmployeeExit = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  input: z.infer<typeof exitSchema>,
): Promise<ServiceResult<EmployeeExit>> => {
  const access = await authorizeExitChange(organizationId, requesterId, employeeId);
  if (!access.ok) return access;

  const [existing] = await db
    .select({ status: employeeExitsTable.status })
    .from(employeeExitsTable)
    .where(exitScope(organizationId, employeeId))
    .limit(1);
  // A completed exit is final unless the employee was reactivated afterwards.
  if (existing?.status === "completed" && !access.data.target.isActive) {
    return fail("conflict", "This employee has already left. Reactivate them first to start a new exit");
  }

  const values = {
    exitType: input.exitType,
    status: "notice" as const,
    resignationDate: input.resignationDate,
    noticeDays: input.noticeDays,
    lastWorkingDay: input.lastWorkingDay ?? addDays(input.resignationDate, input.noticeDays),
    reason: input.reason,
    notes: input.notes,
    completedAt: null,
  };
  const [exit] = await db
    .insert(employeeExitsTable)
    .values({ organizationId, userId: employeeId, ...values })
    .onConflictDoUpdate({
      target: [employeeExitsTable.organizationId, employeeExitsTable.userId],
      set: values,
    })
    .returning(exitColumns);

  const [{ total }] = await db
    .select({ total: count() })
    .from(employeeLifecycleTasksTable)
    .where(taskScope(organizationId, employeeId, "offboarding"));
  if (total === 0) await insertDefaultTasks(organizationId, employeeId, "offboarding");

  return ok(exit);
};

export const completeEmployeeExit = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<ServiceResult<EmployeeExit>> => {
  const access = await authorizeExitChange(organizationId, requesterId, employeeId);
  if (!access.ok) return access;

  return db.transaction(async (trx) => {
    const [exit] = await trx
      .update(employeeExitsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(and(exitScope(organizationId, employeeId), eq(employeeExitsTable.status, "notice")))
      .returning(exitColumns);
    if (!exit) return fail("conflict", "There is no exit in progress for this employee");

    await trx
      .update(userOrganizationsTable)
      .set({ isActive: false })
      .where(
        and(
          eq(userOrganizationsTable.organizationId, organizationId),
          eq(userOrganizationsTable.userId, employeeId),
        ),
      );
    return ok(exit);
  });
};

export const cancelEmployeeExit = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<ServiceResult<EmployeeExit>> => {
  const access = await authorizeExitChange(organizationId, requesterId, employeeId);
  if (!access.ok) return access;

  const [exit] = await db
    .update(employeeExitsTable)
    .set({ status: "cancelled" })
    .where(and(exitScope(organizationId, employeeId), eq(employeeExitsTable.status, "notice")))
    .returning(exitColumns);
  return exit ? ok(exit) : fail("conflict", "There is no exit in progress for this employee");
};
