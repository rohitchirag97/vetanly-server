import { and, count, eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  departmentsTable,
  shiftsTable,
  userOrganizationsTable,
} from "@/drizzle/schema";
import { ALL_ROLES, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { fail, isUniqueViolation, ok, type ServiceResult } from "@/utils/result";
import type {
  createDepartmentSchema,
  createShiftSchema,
  updateDepartmentSchema,
  updateShiftSchema,
} from "@/validator/department-shift.validator";

const departmentColumns = {
  id: departmentsTable.id,
  name: departmentsTable.name,
  code: departmentsTable.code,
  description: departmentsTable.description,
  isActive: departmentsTable.isActive,
};

const shiftColumns = {
  id: shiftsTable.id,
  name: shiftsTable.name,
  startTime: shiftsTable.startTime,
  endTime: shiftsTable.endTime,
  breakMinutes: shiftsTable.breakMinutes,
  gracePeriodMinutes: shiftsTable.gracePeriodMinutes,
  isActive: shiftsTable.isActive,
};

type Department = {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
};

type Shift = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  gracePeriodMinutes: number;
  isActive: boolean;
};

const departmentConflict = "A department with this name or code already exists";
const shiftConflict = "A shift with this name already exists";

export const listDepartments = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<Department[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  return ok(
    await db
      .select(departmentColumns)
      .from(departmentsTable)
      .where(eq(departmentsTable.organizationId, organizationId))
      .orderBy(departmentsTable.name),
  );
};

export const createDepartment = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createDepartmentSchema>,
): Promise<ServiceResult<Department>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  try {
    const [department] = await db
      .insert(departmentsTable)
      .values({ organizationId, ...input })
      .returning(departmentColumns);
    return ok(department);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", departmentConflict);
    throw error;
  }
};

export const updateDepartment = async (
  organizationId: string,
  requesterId: string,
  departmentId: string,
  input: z.infer<typeof updateDepartmentSchema>,
): Promise<ServiceResult<Department>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  try {
    const [department] = await db
      .update(departmentsTable)
      .set(input)
      .where(
        and(
          eq(departmentsTable.id, departmentId),
          eq(departmentsTable.organizationId, organizationId),
        ),
      )
      .returning(departmentColumns);
    return department
      ? ok(department)
      : fail("not-found", "Department not found");
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", departmentConflict);
    throw error;
  }
};

export const deleteDepartment = async (
  organizationId: string,
  requesterId: string,
  departmentId: string,
): Promise<ServiceResult<null>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const [usage] = await db
    .select({ total: count() })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.departmentId, departmentId),
      ),
    );
  if (usage.total > 0) {
    return fail(
      "conflict",
      "Department is assigned to employees; deactivate it instead",
    );
  }

  const deleted = await db
    .delete(departmentsTable)
    .where(
      and(
        eq(departmentsTable.id, departmentId),
        eq(departmentsTable.organizationId, organizationId),
      ),
    )
    .returning({ id: departmentsTable.id });
  return deleted.length > 0 ? ok(null) : fail("not-found", "Department not found");
};

export const listShifts = async (
  organizationId: string,
  requesterId: string,
): Promise<ServiceResult<Shift[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  return ok(
    await db
      .select(shiftColumns)
      .from(shiftsTable)
      .where(eq(shiftsTable.organizationId, organizationId))
      .orderBy(shiftsTable.startTime),
  );
};

export const createShift = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createShiftSchema>,
): Promise<ServiceResult<Shift>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  try {
    const [shift] = await db
      .insert(shiftsTable)
      .values({ organizationId, ...input })
      .returning(shiftColumns);
    return ok(shift);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", shiftConflict);
    throw error;
  }
};

export const updateShift = async (
  organizationId: string,
  requesterId: string,
  shiftId: string,
  input: z.infer<typeof updateShiftSchema>,
): Promise<ServiceResult<Shift>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  try {
    const [shift] = await db
      .update(shiftsTable)
      .set(input)
      .where(
        and(
          eq(shiftsTable.id, shiftId),
          eq(shiftsTable.organizationId, organizationId),
        ),
      )
      .returning(shiftColumns);
    return shift ? ok(shift) : fail("not-found", "Shift not found");
  } catch (error) {
    if (isUniqueViolation(error)) return fail("conflict", shiftConflict);
    throw error;
  }
};

export const deleteShift = async (
  organizationId: string,
  requesterId: string,
  shiftId: string,
): Promise<ServiceResult<null>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const [usage] = await db
    .select({ total: count() })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.shiftId, shiftId),
      ),
    );
  if (usage.total > 0) {
    return fail("conflict", "Shift is assigned to employees; deactivate it instead");
  }

  const deleted = await db
    .delete(shiftsTable)
    .where(
      and(
        eq(shiftsTable.id, shiftId),
        eq(shiftsTable.organizationId, organizationId),
      ),
    )
    .returning({ id: shiftsTable.id });
  return deleted.length > 0 ? ok(null) : fail("not-found", "Shift not found");
};
