import { and, eq } from "drizzle-orm";

import db from "@/utils/db";
import {
  organizationsTable,
  userOrganizationsTable,
  UserRole,
} from "@/drizzle/schema";
import { fail, ok, type ServiceResult } from "@/utils/result";

export const ALL_ROLES: readonly string[] = Object.values(UserRole);
export const MANAGER_ROLES: readonly string[] = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
];
// HR manages people operations but is intentionally excluded from finance,
// organization security, and privileged device administration.
export const PEOPLE_MANAGER_ROLES: readonly string[] = [
  ...MANAGER_ROLES,
  UserRole.HR,
];
export const OWNER_ROLES: readonly string[] = [UserRole.SUPER_ADMIN];

export type ActiveMembership = { id: string; role: string };

export const getActiveMembership = async (
  organizationId: string,
  userId: string,
): Promise<ActiveMembership | null> => {
  const [membership] = await db
    .select({
      id: userOrganizationsTable.id,
      role: userOrganizationsTable.role,
    })
    .from(userOrganizationsTable)
    .innerJoin(
      organizationsTable,
      eq(organizationsTable.id, userOrganizationsTable.organizationId),
    )
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.userId, userId),
        eq(userOrganizationsTable.isActive, true),
        eq(organizationsTable.isActive, true),
        eq(organizationsTable.status, "active"),
      ),
    )
    .limit(1);
  return membership ?? null;
};

export const requireRole = async (
  organizationId: string,
  userId: string,
  roles: readonly string[],
): Promise<ServiceResult<ActiveMembership>> => {
  const membership = await getActiveMembership(organizationId, userId);
  if (!membership || !roles.includes(membership.role)) return fail("forbidden");
  return ok(membership);
};

export const getEmployeeMembership = async (
  organizationId: string,
  employeeUserId: string,
) => {
  const [membership] = await db
    .select({
      id: userOrganizationsTable.id,
      role: userOrganizationsTable.role,
      isActive: userOrganizationsTable.isActive,
    })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.userId, employeeUserId),
      ),
    )
    .limit(1);
  return membership ?? null;
};

export type EmployeeRecordAccess = {
  isSelf: boolean;
  isManager: boolean;
  requesterRole: string;
  target: { id: string; role: string; isActive: boolean };
};

/**
 * Employees may reach their own records (when selfAllowed); everything else needs a manager.
 * A non-owner admin can never touch the super admin's records.
 */
export const authorizeEmployeeRecord = async (
  organizationId: string,
  requesterId: string,
  employeeId: string,
  selfAllowed: boolean,
): Promise<ServiceResult<EmployeeRecordAccess>> => {
  const isSelf = requesterId === employeeId;
  const access = await requireRole(
    organizationId,
    requesterId,
    selfAllowed && isSelf ? ALL_ROLES : PEOPLE_MANAGER_ROLES,
  );
  if (!access.ok) return access;

  const target = await getEmployeeMembership(organizationId, employeeId);
  if (!target) return fail("not-found", "Employee not found");
  if (!isSelf) {
    if (target.role === UserRole.SUPER_ADMIN && access.data.role !== UserRole.SUPER_ADMIN) {
      return fail("forbidden");
    }
    if (access.data.role === UserRole.HR && target.role !== UserRole.EMPLOYEE) {
      return fail("forbidden");
    }
  }
  return ok({
    isSelf,
    isManager: PEOPLE_MANAGER_ROLES.includes(access.data.role),
    requesterRole: access.data.role,
    target,
  });
};
