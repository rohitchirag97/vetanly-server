import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import {
  assetAssignmentsTable as assignments,
  assetsTable as assets,
  branchesTable,
  userOrganizationsTable as memberships,
  usersTable,
} from "@/drizzle/schema";
import {
  ALL_ROLES,
  authorizeEmployeeRecord,
  canManageMember,
  getEmployeeMembership,
  PEOPLE_MANAGER_ROLES,
  requireRole,
  type ActiveMembership,
} from "@/services/access.services";
import { notify } from "@/services/notification.services";
import { fail, isUniqueViolation, ok } from "@/utils/result";
import type {
  assetSchema,
  assetStatusSchema,
  assignAssetSchema,
  listAssetsQuerySchema,
  returnAssetSchema,
} from "@/validator/asset.validator";

/**
 * The asset register and who holds what. Owners, admins and HR manage it; a branch manager only
 * the assets of their branches, handed to their branches' people. Employees see and acknowledge
 * what they hold.
 */

const holderName = { fname: usersTable.fname, lname: usersTable.lname, employeeId: usersTable.id };

const assetColumns = {
  id: assets.id,
  assetTag: assets.assetTag,
  name: assets.name,
  category: assets.category,
  serialNumber: assets.serialNumber,
  brand: assets.brand,
  model: assets.model,
  purchaseDate: assets.purchaseDate,
  purchaseCost: assets.purchaseCost,
  warrantyUntil: assets.warrantyUntil,
  branchId: assets.branchId,
  branchName: branchesTable.name,
  condition: assets.condition,
  status: assets.status,
  notes: assets.notes,
  retiredReason: assets.retiredReason,
  holderMembershipId: assets.holderMembershipId,
  ...holderName,
  updatedAt: assets.updatedAt,
};

const selectAssets = (where: SQL | undefined) =>
  db
    .select(assetColumns)
    .from(assets)
    .leftJoin(branchesTable, eq(branchesTable.id, assets.branchId))
    .leftJoin(memberships, eq(memberships.id, assets.holderMembershipId))
    .leftJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(where);

const toAsset = ({ fname, lname, employeeId, ...row }: Awaited<ReturnType<typeof selectAssets>>[number]) => ({
  ...row,
  holder: row.holderMembershipId && employeeId ? { employeeId, name: `${fname} ${lname}`.trim() } : null,
});

export type Asset = ReturnType<typeof toAsset>;

/** A branch manager handles only their branches' assets; everyone else the whole register. */
const canManageAsset = (manager: ActiveMembership, asset: { branchId: string | null }) =>
  !manager.branchIds || (!!asset.branchId && manager.branchIds.includes(asset.branchId));

const loadAsset = async (organizationId: string, assetId: string) => {
  const [row] = await selectAssets(and(eq(assets.organizationId, organizationId), eq(assets.id, assetId))).limit(1);
  return row ? toAsset(row) : null;
};

const manageable = async (organizationId: string, requesterId: string, assetId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const asset = await loadAsset(organizationId, assetId);
  if (!asset || !canManageAsset(access.data, asset)) return fail("not-found", "Asset not found");
  return ok({ access: access.data, asset });
};

export const listAssets = async (organizationId: string, requesterId: string, query: z.infer<typeof listAssetsQuerySchema>) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const conditions: SQL[] = [eq(assets.organizationId, organizationId)];
  if (query.status) conditions.push(eq(assets.status, query.status));
  if (query.category) conditions.push(eq(assets.category, query.category));
  if (query.branchId) conditions.push(eq(assets.branchId, query.branchId));
  if (access.data.branchIds) conditions.push(inArray(assets.branchId, access.data.branchIds));
  const rows = await selectAssets(and(...conditions)).orderBy(asc(assets.assetTag)).limit(2000);
  return ok(rows.map(toAsset));
};

const checkBranch = async (organizationId: string, manager: ActiveMembership, branchId: string | null | undefined) => {
  if (manager.branchIds && !(branchId && manager.branchIds.includes(branchId))) {
    return fail("forbidden", "Choose one of your branches");
  }
  if (branchId) {
    const [branch] = await db
      .select({ id: branchesTable.id })
      .from(branchesTable)
      .where(and(eq(branchesTable.id, branchId), eq(branchesTable.organizationId, organizationId)))
      .limit(1);
    if (!branch) return fail("invalid", "Branch not found");
  }
  return null;
};

const toValues = (input: z.infer<typeof assetSchema>) => ({
  assetTag: input.assetTag,
  name: input.name,
  category: input.category,
  serialNumber: input.serialNumber || null,
  brand: input.brand || null,
  model: input.model || null,
  purchaseDate: input.purchaseDate ?? null,
  purchaseCost: input.purchaseCost == null ? null : input.purchaseCost.toFixed(2),
  warrantyUntil: input.warrantyUntil ?? null,
  branchId: input.branchId ?? null,
  condition: input.condition,
  notes: input.notes || null,
  updatedAt: new Date(),
});

const tagTaken = () => fail("conflict", "Another asset already has this tag");

export const createAsset = async (organizationId: string, requesterId: string, input: z.infer<typeof assetSchema>) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const branchError = await checkBranch(organizationId, access.data, input.branchId);
  if (branchError) return branchError;
  try {
    const [created] = await db.insert(assets).values({ organizationId, ...toValues(input) }).returning({ id: assets.id });
    return ok((await loadAsset(organizationId, created!.id))!);
  } catch (error) {
    if (isUniqueViolation(error)) return tagTaken();
    throw error;
  }
};

export const updateAsset = async (organizationId: string, requesterId: string, assetId: string, input: z.infer<typeof assetSchema>) => {
  const found = await manageable(organizationId, requesterId, assetId);
  if (!found.ok) return found;
  const branchError = await checkBranch(organizationId, found.data.access, input.branchId);
  if (branchError) return branchError;
  try {
    await db.update(assets).set(toValues(input)).where(eq(assets.id, assetId));
  } catch (error) {
    if (isUniqueViolation(error)) return tagTaken();
    throw error;
  }
  return ok((await loadAsset(organizationId, assetId))!);
};

/** Hands an available asset to an employee, who is asked to acknowledge it. */
export const assignAsset = async (organizationId: string, requesterId: string, assetId: string, input: z.infer<typeof assignAssetSchema>) => {
  const found = await manageable(organizationId, requesterId, assetId);
  if (!found.ok) return found;
  const { access, asset } = found.data;
  if (asset.status !== "available") return fail("conflict", "Only an available asset can be assigned; take it back or out of repair first");
  const target = await getEmployeeMembership(organizationId, input.employeeId);
  if (!target?.isActive) return fail("not-found", "Employee not found");
  if (!canManageMember(access, target)) return fail("forbidden", "You cannot assign assets to this person");

  const assigned = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(assets)
      .set({ status: "assigned", holderMembershipId: target.id, condition: input.condition, updatedAt: new Date() })
      .where(and(eq(assets.id, assetId), eq(assets.status, "available")))
      .returning({ id: assets.id });
    if (!updated) return false;
    await tx.insert(assignments).values({
      organizationId,
      assetId,
      userOrganizationId: target.id,
      assignedOn: input.assignedOn,
      conditionOut: input.condition,
      notesOut: input.notes || null,
      assignedByUserId: requesterId,
    });
    return true;
  });
  if (!assigned) return fail("conflict", "This asset was just assigned by someone else");
  await notify({
    organizationId,
    userIds: [input.employeeId],
    type: "asset_assigned",
    title: `${asset.name} (${asset.assetTag}) has been handed to you`,
    body: "Please confirm you received it",
    link: "/my-assets",
  });
  return ok((await loadAsset(organizationId, assetId))!);
};

const openAssignment = async (assetId: string) => {
  const [row] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.assetId, assetId), isNull(assignments.returnedOn), eq(assignments.lost, false)))
    .orderBy(desc(assignments.createdAt))
    .limit(1);
  return row ?? null;
};

/** Takes an asset back, or records it as lost (it is then retired). */
export const returnAsset = async (organizationId: string, requesterId: string, assetId: string, input: z.infer<typeof returnAssetSchema>) => {
  const found = await manageable(organizationId, requesterId, assetId);
  if (!found.ok) return found;
  const { asset } = found.data;
  if (asset.status !== "assigned") return fail("conflict", "This asset is not assigned to anyone");
  const assignment = await openAssignment(assetId);
  if (!assignment) return fail("conflict", "This asset is not assigned to anyone");
  if (input.returnedOn < assignment.assignedOn) return fail("invalid", "The return date is before it was handed over");

  await db.transaction(async (tx) => {
    await tx
      .update(assignments)
      .set({ returnedOn: input.returnedOn, conditionIn: input.condition, notesIn: input.notes || null, receivedByUserId: requesterId, lost: input.lost })
      .where(eq(assignments.id, assignment.id));
    await tx
      .update(assets)
      .set(
        input.lost
          ? { status: "retired", holderMembershipId: null, retiredReason: `Lost while with ${asset.holder?.name ?? "an employee"}`, updatedAt: new Date() }
          : { status: "available", holderMembershipId: null, condition: input.condition, updatedAt: new Date() },
      )
      .where(eq(assets.id, assetId));
  });
  return ok((await loadAsset(organizationId, assetId))!);
};

/** Repair, back in service, or retired (sold, scrapped, lost). Not while someone holds it. */
export const setAssetStatus = async (organizationId: string, requesterId: string, assetId: string, input: z.infer<typeof assetStatusSchema>) => {
  const found = await manageable(organizationId, requesterId, assetId);
  if (!found.ok) return found;
  if (found.data.asset.status === "assigned") return fail("conflict", "Take the asset back from the employee first");
  await db
    .update(assets)
    .set({ status: input.status, retiredReason: input.status === "retired" ? input.reason!.trim() : null, updatedAt: new Date() })
    .where(eq(assets.id, assetId));
  return ok((await loadAsset(organizationId, assetId))!);
};

/** Only an asset that was never handed out can be deleted; otherwise retire it to keep its history. */
export const deleteAsset = async (organizationId: string, requesterId: string, assetId: string) => {
  const found = await manageable(organizationId, requesterId, assetId);
  if (!found.ok) return found;
  const [used] = await db.select({ id: assignments.id }).from(assignments).where(eq(assignments.assetId, assetId)).limit(1);
  if (used) return fail("conflict", "This asset has a handover history. Retire it instead of deleting it");
  await db.delete(assets).where(eq(assets.id, assetId));
  return ok(null);
};

const historyColumns = {
  id: assignments.id,
  assetId: assignments.assetId,
  assignedOn: assignments.assignedOn,
  conditionOut: assignments.conditionOut,
  notesOut: assignments.notesOut,
  acknowledgedAt: assignments.acknowledgedAt,
  returnedOn: assignments.returnedOn,
  conditionIn: assignments.conditionIn,
  notesIn: assignments.notesIn,
  lost: assignments.lost,
  employeeId: usersTable.id,
  fname: usersTable.fname,
  lname: usersTable.lname,
};

const toHistory = <T extends { fname: string; lname: string }>({ fname, lname, ...row }: T) => ({
  ...row,
  employeeName: `${fname} ${lname}`.trim(),
});

export const assetHistory = async (organizationId: string, requesterId: string, assetId: string) => {
  const found = await manageable(organizationId, requesterId, assetId);
  if (!found.ok) return found;
  const rows = await db
    .select(historyColumns)
    .from(assignments)
    .innerJoin(memberships, eq(memberships.id, assignments.userOrganizationId))
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(eq(assignments.assetId, assetId))
    .orderBy(desc(assignments.assignedOn), desc(assignments.createdAt));
  return ok({ asset: found.data.asset, history: rows.map(toHistory) });
};

/** Everything one employee holds or held: for their profile, and for the employee themselves. */
const employeeAssignments = async (membershipId: string) => {
  const rows = await db
    .select({
      assignmentId: assignments.id,
      assetId: assets.id,
      assetTag: assets.assetTag,
      name: assets.name,
      category: assets.category,
      serialNumber: assets.serialNumber,
      purchaseCost: assets.purchaseCost,
      assignedOn: assignments.assignedOn,
      conditionOut: assignments.conditionOut,
      notesOut: assignments.notesOut,
      acknowledgedAt: assignments.acknowledgedAt,
      returnedOn: assignments.returnedOn,
      conditionIn: assignments.conditionIn,
      lost: assignments.lost,
    })
    .from(assignments)
    .innerJoin(assets, eq(assets.id, assignments.assetId))
    .where(eq(assignments.userOrganizationId, membershipId))
    .orderBy(desc(assignments.assignedOn));
  return {
    current: rows.filter((row) => !row.returnedOn && !row.lost),
    past: rows.filter((row) => row.returnedOn || row.lost),
  };
};

export const myAssets = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  return ok(await employeeAssignments(access.data.id));
};

export const employeeAssets = async (organizationId: string, requesterId: string, employeeId: string) => {
  const access = await authorizeEmployeeRecord(organizationId, requesterId, employeeId, true);
  if (!access.ok) return access;
  return ok(await employeeAssignments(access.data.target.id));
};

/** The employee confirms they received an asset. */
export const acknowledgeAsset = async (organizationId: string, requesterId: string, assignmentId: string) => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;
  const [updated] = await db
    .update(assignments)
    .set({ acknowledgedAt: new Date() })
    .where(
      and(
        eq(assignments.id, assignmentId),
        eq(assignments.organizationId, organizationId),
        eq(assignments.userOrganizationId, access.data.id),
        isNull(assignments.acknowledgedAt),
        isNull(assignments.returnedOn),
      ),
    )
    .returning({ id: assignments.id });
  if (!updated) return fail("not-found", "Nothing to acknowledge");
  return ok(await employeeAssignments(access.data.id));
};

/** Assets a leaver still holds, for the full & final settlement. */
export const assetsHeldBy = async (membershipId: string) =>
  db
    .select({ assetTag: assets.assetTag, name: assets.name, category: assets.category, purchaseCost: assets.purchaseCost, assignedOn: assignments.assignedOn })
    .from(assignments)
    .innerJoin(assets, eq(assets.id, assignments.assetId))
    .where(and(eq(assignments.userOrganizationId, membershipId), isNull(assignments.returnedOn), eq(assignments.lost, false)));

/** Members who may receive assets, for the assign picker (respects HR and branch limits). */
export const assignableEmployees = async (organizationId: string, requesterId: string) => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const rows = await db
    .select({ employeeId: usersTable.id, fname: usersTable.fname, lname: usersTable.lname, role: memberships.role, branchId: memberships.branchId, code: memberships.employeeCode })
    .from(memberships)
    .innerJoin(usersTable, eq(usersTable.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.isActive, true), access.data.branchIds ? inArray(memberships.branchId, access.data.branchIds) : undefined))
    .orderBy(usersTable.fname, usersTable.lname);
  return ok(
    rows
      .filter((row) => canManageMember(access.data, row))
      .map((row) => ({ employeeId: row.employeeId, name: `${row.fname} ${row.lname}`.trim(), code: row.code })),
  );
};
