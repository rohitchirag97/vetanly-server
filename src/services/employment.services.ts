import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  departmentsTable,
  shiftsTable,
  userOrganizationsTable,
  UserRole,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  getEmployeeMembership,
  OWNER_ROLES,
  PEOPLE_MANAGER_ROLES,
  requireRole,
} from "@/services/access.services";
import { fail, isUniqueViolation, ok, type ServiceResult } from "@/utils/result";
import type { updateEmploymentSchema } from "@/validator/employment.validator";

const selectEmployment = async (organizationId: string, employeeId: string) => {
  const [employment] = await db
    .select({
      membershipId: userOrganizationsTable.id,
      employeeId: userOrganizationsTable.userId,
      role: userOrganizationsTable.role,
      isActive: userOrganizationsTable.isActive,
      includeInPayroll: userOrganizationsTable.includeInPayroll,
      employeeCode: userOrganizationsTable.employeeCode,
      jobTitle: userOrganizationsTable.jobTitle,
      departmentId: userOrganizationsTable.departmentId,
      departmentName: departmentsTable.name,
      shiftId: userOrganizationsTable.shiftId,
      shiftName: shiftsTable.name,
      employmentType: userOrganizationsTable.employmentType,
      hireDate: userOrganizationsTable.hireDate,
      compensationType: userOrganizationsTable.compensationType,
      compensationAmount: userOrganizationsTable.compensationAmount,
      compensationCurrency: userOrganizationsTable.compensationCurrency,
      payFrequency: userOrganizationsTable.payFrequency,
      salaryComponents: userOrganizationsTable.salaryComponents,
    })
    .from(userOrganizationsTable)
    .leftJoin(
      departmentsTable,
      eq(departmentsTable.id, userOrganizationsTable.departmentId),
    )
    .leftJoin(shiftsTable, eq(shiftsTable.id, userOrganizationsTable.shiftId))
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.userId, employeeId),
      ),
    )
    .limit(1);
  return employment ?? null;
};

type Employment = NonNullable<Awaited<ReturnType<typeof selectEmployment>>>;

export const getEmployment = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
): Promise<ServiceResult<Employment>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  if (requesterId !== employeeId && !PEOPLE_MANAGER_ROLES.includes(access.data.role)) {
    return fail("forbidden");
  }
  const membership = await getEmployeeMembership(organizationId, employeeId);
  if (!membership) return fail("not-found", "Employee not found in this organization");
  if (
    access.data.role === UserRole.HR &&
    employeeId !== requesterId &&
    membership.role !== UserRole.EMPLOYEE
  ) {
    return fail("forbidden");
  }
  const employment = await selectEmployment(organizationId, employeeId);
  return employment ? ok(employment) : fail("not-found", "Employee not found in this organization");
};

export const updateEmployment = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  input: z.infer<typeof updateEmploymentSchema>,
): Promise<ServiceResult<Employment>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const target = await getEmployeeMembership(organizationId, employeeId);
  if (!target) return fail("not-found", "Employee not found in this organization");
  if (
    target.role === UserRole.SUPER_ADMIN &&
    access.data.role !== UserRole.SUPER_ADMIN
  ) {
    return fail("forbidden", "Only the organization owner can change owner details");
  }
  if (access.data.role === UserRole.HR && target.role !== UserRole.EMPLOYEE) {
    return fail("forbidden");
  }

  if (input.departmentId) {
    const [department] = await db
      .select({ id: departmentsTable.id })
      .from(departmentsTable)
      .where(
        and(
          eq(departmentsTable.id, input.departmentId),
          eq(departmentsTable.organizationId, organizationId),
          eq(departmentsTable.isActive, true),
        ),
      )
      .limit(1);
    if (!department) return fail("invalid", "Department not found or inactive");
  }

  if (input.shiftId) {
    const [shift] = await db
      .select({ id: shiftsTable.id })
      .from(shiftsTable)
      .where(
        and(
          eq(shiftsTable.id, input.shiftId),
          eq(shiftsTable.organizationId, organizationId),
          eq(shiftsTable.isActive, true),
        ),
      )
      .limit(1);
    if (!shift) return fail("invalid", "Shift not found or inactive");
  }

  const { compensationAmount, ...rest } = input;
  try {
    await db
      .update(userOrganizationsTable)
      .set({
        ...rest,
        ...(compensationAmount === undefined
          ? {}
          : {
              compensationAmount:
                compensationAmount === null ? null : compensationAmount.toFixed(2),
            }),
      })
      .where(eq(userOrganizationsTable.id, target.id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail("conflict", "This employee code is already used in the organization");
    }
    throw error;
  }

  const employment = await selectEmployment(organizationId, employeeId);
  return employment ? ok(employment) : fail("not-found");
};

export const setOwnPayrollInclusion = async (
  organizationId: string,
  requesterId: string,
  includeInPayroll: boolean,
): Promise<ServiceResult<{ includeInPayroll: boolean }>> => {
  const access = await requireRole(organizationId, requesterId, OWNER_ROLES);
  if (!access.ok) return access;

  const [membership] = await db
    .update(userOrganizationsTable)
    .set({ includeInPayroll })
    .where(
      and(
        eq(userOrganizationsTable.id, access.data.id),
        eq(userOrganizationsTable.role, UserRole.SUPER_ADMIN),
      ),
    )
    .returning({ includeInPayroll: userOrganizationsTable.includeInPayroll });

  return membership ? ok(membership) : fail("not-found", "Owner membership not found");
};
