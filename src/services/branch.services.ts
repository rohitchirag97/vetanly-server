import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  branchesTable as branches,
  branchManagersTable as managers,
  kioskDevicesTable,
  userOrganizationsTable as memberships,
  usersTable,
  UserRole,
} from "@/drizzle/schema";
import { MANAGER_ROLES, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { fail, isUniqueViolation, ok } from "@/utils/result";
import type { branchManagersSchema, branchSchema } from "@/validator/branch.validator";

/**
 * Branches (offices, sites, stores). Owners and admins of the whole organization create and edit them
 * and choose who manages each; managers limited to some branches see the list to filter by.
 */

const toValues = (input: z.infer<typeof branchSchema>) => ({
  name: input.name,
  code: input.code || null,
  addressLine1: input.addressLine1 || null,
  addressLine2: input.addressLine2 || null,
  city: input.city || null,
  state: input.state || null,
  postalCode: input.postalCode || null,
  ptState: input.ptState ?? null,
  ptFlatAmount: input.ptState === "FLAT" && input.ptFlatAmount != null ? input.ptFlatAmount.toFixed(2) : null,
  latitude: input.latitude == null ? null : input.latitude.toFixed(6),
  longitude: input.longitude == null ? null : input.longitude.toFixed(6),
  geofenceRadiusMeters: input.geofenceRadiusMeters,
  gpsCheckIn: input.gpsCheckIn,
  updatedAt: new Date(),
});

export const listBranches = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const [rows, employees, kiosks, managerRows] = await Promise.all([
    db.select().from(branches).where(eq(branches.organizationId, organizationId)).orderBy(asc(branches.name)),
    db
      .select({ branchId: memberships.branchId, n: count() })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.isActive, true)))
      .groupBy(memberships.branchId),
    db
      .select({ branchId: kioskDevicesTable.branchId, n: count() })
      .from(kioskDevicesTable)
      .where(and(eq(kioskDevicesTable.organizationId, organizationId), eq(kioskDevicesTable.isActive, true)))
      .groupBy(kioskDevicesTable.branchId),
    db
      .select({ branchId: managers.branchId, employeeId: memberships.userId, fname: usersTable.fname, lname: usersTable.lname, role: memberships.role })
      .from(managers)
      .innerJoin(memberships, eq(memberships.id, managers.userOrganizationId))
      .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
      .where(eq(managers.organizationId, organizationId)),
  ]);
  const scope = access.data.branchIds;
  return ok({
    branches: rows.map((branch) => ({
      ...branch,
      latitude: branch.latitude === null ? null : Number(branch.latitude),
      longitude: branch.longitude === null ? null : Number(branch.longitude),
      ptFlatAmount: branch.ptFlatAmount === null ? null : Number(branch.ptFlatAmount),
      employeeCount: employees.find((row) => row.branchId === branch.id)?.n ?? 0,
      kioskCount: kiosks.find((row) => row.branchId === branch.id)?.n ?? 0,
      managers: managerRows
        .filter((row) => row.branchId === branch.id)
        .map((row) => ({ employeeId: row.employeeId, name: `${row.fname} ${row.lname}`.trim(), role: row.role })),
      manageable: !scope || scope.includes(branch.id),
    })),
    unassignedCount: employees.find((row) => row.branchId === null)?.n ?? 0,
    // Whether the requester is limited to some branches (they cannot edit branches).
    limitedTo: scope,
  });
};

const nameTaken = (error: unknown) => isUniqueViolation(error);

export const createBranch = async (organizationId: string, requesterId: string, input: z.infer<typeof branchSchema>) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  try {
    const [created] = await db.insert(branches).values({ organizationId, ...toValues(input) }).returning({ id: branches.id });
    return ok({ id: created!.id });
  } catch (error) {
    if (nameTaken(error)) return fail("conflict", "A branch with this name already exists");
    throw error;
  }
};

export const updateBranch = async (organizationId: string, requesterId: string, branchId: string, input: z.infer<typeof branchSchema>) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  try {
    const [updated] = await db
      .update(branches)
      .set(toValues(input))
      .where(and(eq(branches.id, branchId), eq(branches.organizationId, organizationId)))
      .returning({ id: branches.id });
    return updated ? ok({ id: updated.id }) : fail("not-found", "Branch not found");
  } catch (error) {
    if (nameTaken(error)) return fail("conflict", "A branch with this name already exists");
    throw error;
  }
};

/** Closing a branch needs its people moved first; its kiosks and holidays stay linked for history. */
export const setBranchActive = async (organizationId: string, requesterId: string, branchId: string, isActive: boolean) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  if (!isActive) {
    const [people] = await db
      .select({ n: count() })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.branchId, branchId), eq(memberships.isActive, true)));
    if (people && people.n > 0) {
      return fail("conflict", `${people.n} active employee(s) still belong to this branch. Move them to another branch first`);
    }
  }
  const [updated] = await db
    .update(branches)
    .set({ isActive, ...(isActive ? {} : { gpsCheckIn: false }), updatedAt: new Date() })
    .where(and(eq(branches.id, branchId), eq(branches.organizationId, organizationId)))
    .returning({ id: branches.id });
  if (!updated) return fail("not-found", "Branch not found");
  if (!isActive) await db.delete(managers).where(eq(managers.branchId, branchId));
  return ok({ id: updated.id });
};

/**
 * Sets who manages a branch. Each person named becomes limited to the branches they manage; someone
 * removed from their last branch manages the whole organization again. Only admins and HR qualify.
 */
export const setBranchManagers = async (
  organizationId: string,
  requesterId: string,
  branchId: string,
  input: z.infer<typeof branchManagersSchema>,
) => {
  const access = await requireRole(organizationId, requesterId, MANAGER_ROLES);
  if (!access.ok) return access;
  const [branch] = await db
    .select({ id: branches.id, isActive: branches.isActive })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.organizationId, organizationId)))
    .limit(1);
  if (!branch?.isActive) return fail("not-found", "Branch not found");

  const people = input.employeeIds.length
    ? await db
        .select({ id: memberships.id, userId: memberships.userId, role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.organizationId, organizationId), inArray(memberships.userId, input.employeeIds), eq(memberships.isActive, true)))
    : [];
  if (people.length !== new Set(input.employeeIds).size) return fail("invalid", "Someone chosen is not an active member");
  if (people.some((person) => person.role !== UserRole.ADMIN && person.role !== UserRole.HR)) {
    return fail("invalid", "Only admins and HR can manage a branch");
  }
  if (people.some((person) => person.userId === requesterId)) {
    return fail("invalid", "You cannot limit yourself to a branch");
  }

  await db.transaction(async (tx) => {
    // Replace the set: remove everyone, then add those chosen.
    await tx.delete(managers).where(eq(managers.branchId, branchId));
    if (people.length) {
      await tx.insert(managers).values(people.map((person) => ({ organizationId, userOrganizationId: person.id, branchId })));
    }
  });
  return ok({ branchId, managers: people.length });
};
