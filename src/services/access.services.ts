import { and, eq, inArray, notInArray, or } from "drizzle-orm";

import db from "@/utils/db";
import {
  branchManagersTable,
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

/**
 * branchIds: the branches an admin or HR is limited to; null when they manage the whole organization
 * (no branch_managers rows, and always for the owner and plain employees).
 */
export type ActiveMembership = { id: string; role: string; branchIds: string[] | null };

const LIMITABLE_ROLES: readonly string[] = [UserRole.ADMIN, UserRole.HR];

/** The branches a member is limited to, or null for the whole organization. */
export const branchScopeOf = async (membershipId: string, role: string): Promise<string[] | null> => {
  if (!LIMITABLE_ROLES.includes(role)) return null;
  const rows = await db
    .select({ branchId: branchManagersTable.branchId })
    .from(branchManagersTable)
    .where(eq(branchManagersTable.userOrganizationId, membershipId));
  return rows.length ? rows.map((row) => row.branchId) : null;
};

/**
 * Whether a manager may act on another member: HR only on plain employees, and a branch-limited
 * manager only on people in their branches (not on people without a branch).
 */
export const canManageMember = (
  manager: { role: string; branchIds: string[] | null },
  target: { role: string; branchId: string | null },
) => {
  if (manager.role === UserRole.HR && target.role !== UserRole.EMPLOYEE) return false;
  if (manager.branchIds && !(target.branchId && manager.branchIds.includes(target.branchId))) return false;
  return true;
};

/** Narrows a members query to the manager's branches; nothing for whole-organization managers. */
export const branchCondition = (manager: { branchIds: string[] | null }) =>
  manager.branchIds ? inArray(userOrganizationsTable.branchId, manager.branchIds) : undefined;

/** Counted as an employee (lists, payroll, billing): everyone but the owner and admins, unless they are on payroll. */
export const countsAsEmployee = () =>
  or(
    notInArray(userOrganizationsTable.role, [UserRole.SUPER_ADMIN, UserRole.ADMIN]),
    eq(userOrganizationsTable.includeInPayroll, true),
  )!;

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
  if (!membership) return null;
  return { ...membership, branchIds: await branchScopeOf(membership.id, membership.role) };
};

/**
 * Role lists without HR (MANAGER_ROLES, OWNER_ROLES) guard finance and organization-wide settings:
 * payroll, bonus, settlements, branches, kiosks. A branch-limited admin is refused those.
 */
export const requireRole = async (
  organizationId: string,
  userId: string,
  roles: readonly string[],
): Promise<ServiceResult<ActiveMembership>> => {
  const membership = await getActiveMembership(organizationId, userId);
  if (!membership || !roles.includes(membership.role)) return fail("forbidden");
  if (membership.branchIds && !roles.includes(UserRole.HR)) {
    return fail("forbidden", "This needs an admin for the whole organization, not a branch admin");
  }
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
      branchId: userOrganizationsTable.branchId,
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
  target: { id: string; role: string; isActive: boolean; branchId: string | null };
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
    if (!canManageMember(access.data, target)) return fail("forbidden");
  }
  return ok({
    isSelf,
    isManager: PEOPLE_MANAGER_ROLES.includes(access.data.role),
    requesterRole: access.data.role,
    target,
  });
};

/**
 * Branches a list should cover: the one asked for (none when it is outside the manager's branches),
 * else the manager's own branches, else undefined for everything.
 */
export const branchFilter = (manager: { branchIds: string[] | null }, requested?: string): string[] | undefined => {
  if (requested) return manager.branchIds && !manager.branchIds.includes(requested) ? [] : [requested];
  return manager.branchIds ?? undefined;
};

/** An owner or admin of the whole organization: finance and settings, not limited to some branches. */
export const isOrganizationManager = (member: { role: string; branchIds: string[] | null }) =>
  MANAGER_ROLES.includes(member.role) && !member.branchIds;
