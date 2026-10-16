import { and, asc, eq, gte, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import { branchesTable, holidaysTable, userOrganizationsTable } from "@/drizzle/schema";
import { ALL_ROLES, PEOPLE_MANAGER_ROLES, requireRole, type ActiveMembership } from "@/services/access.services";
import { eachDate } from "@/services/payroll-calc";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  createHolidaySchema,
  listHolidaysQuerySchema,
  updateHolidaySchema,
} from "@/validator/holiday.validator";

/** branchId null: a holiday for every branch. */
export type Holiday = { id: string; date: string; name: string; branchId: string | null; branchName: string | null };

const columns = {
  id: holidaysTable.id,
  date: holidaysTable.date,
  name: holidaysTable.name,
  branchId: holidaysTable.branchId,
};

export type HolidayRow = { date: string; branchId: string | null };

export const holidayDatesBetween = async (
  organizationId: string,
  from: string,
  to: string,
): Promise<HolidayRow[]> =>
  db
    .select({ date: holidaysTable.date, branchId: holidaysTable.branchId })
    .from(holidaysTable)
    .where(
      and(
        eq(holidaysTable.organizationId, organizationId),
        gte(holidaysTable.date, from),
        lte(holidaysTable.date, to),
      ),
    );

/** The holiday dates that apply to someone in this branch: company-wide ones plus the branch's own. */
export const holidaysForBranch = (rows: HolidayRow[], branchId: string | null) =>
  [...new Set(rows.filter((row) => row.branchId === null || row.branchId === branchId).map((row) => row.date))];

const withBranchNames = async (organizationId: string, rows: Omit<Holiday, "branchName">[]): Promise<Holiday[]> => {
  const ids = [...new Set(rows.flatMap((row) => (row.branchId ? [row.branchId] : [])))];
  const branches = ids.length
    ? await db
        .select({ id: branchesTable.id, name: branchesTable.name })
        .from(branchesTable)
        .where(and(eq(branchesTable.organizationId, organizationId), inArray(branchesTable.id, ids)))
    : [];
  const names = new Map(branches.map((branch) => [branch.id, branch.name]));
  return rows.map((row) => ({ ...row, branchName: row.branchId ? (names.get(row.branchId) ?? null) : null }));
};

/** A branch-limited manager may only change their branches' holidays, never company-wide ones. */
const canEditHoliday = (manager: ActiveMembership, branchId: string | null) =>
  !manager.branchIds || (branchId !== null && manager.branchIds.includes(branchId));

export const listHolidays = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof listHolidaysQuerySchema>,
): Promise<ServiceResult<Holiday[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const conditions: SQL[] = [eq(holidaysTable.organizationId, organizationId)];
  if (query.from) conditions.push(gte(holidaysTable.date, query.from));
  if (query.to) conditions.push(lte(holidaysTable.date, query.to));

  // Managers see every branch's holidays (or one branch's); everyone else sees the ones that apply to them.
  const isManager = PEOPLE_MANAGER_ROLES.includes(access.data.role) && query.mine !== "true";
  const branchId = isManager ? query.branchId : await ownBranch(access.data.id);
  if (branchId !== undefined) {
    conditions.push(branchId ? or(isNull(holidaysTable.branchId), eq(holidaysTable.branchId, branchId))! : isNull(holidaysTable.branchId));
  }

  const rows = await db
    .select(columns)
    .from(holidaysTable)
    .where(and(...conditions))
    .orderBy(asc(holidaysTable.date))
    .limit(500);
  return ok(await withBranchNames(organizationId, rows));
};

const ownBranch = async (membershipId: string) => {
  const [row] = await db
    .select({ branchId: userOrganizationsTable.branchId })
    .from(userOrganizationsTable)
    .where(eq(userOrganizationsTable.id, membershipId))
    .limit(1);
  return row?.branchId ?? null;
};

export const createHoliday = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createHolidaySchema>,
): Promise<ServiceResult<Holiday[]>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const branchId = input.branchId ?? null;
  if (!canEditHoliday(access.data, branchId)) {
    return fail("forbidden", "You can only add holidays for your branches");
  }
  if (branchId) {
    const [branch] = await db
      .select({ id: branchesTable.id })
      .from(branchesTable)
      .where(and(eq(branchesTable.id, branchId), eq(branchesTable.organizationId, organizationId)))
      .limit(1);
    if (!branch) return fail("invalid", "Branch not found");
  }

  const dates = eachDate(input.date, input.endDate ?? input.date);
  const inserted = await db
    .insert(holidaysTable)
    .values(dates.map((date) => ({ organizationId, date, name: input.name, branchId })))
    .onConflictDoNothing()
    .returning(columns);

  if (inserted.length === 0) {
    return fail("conflict", "A holiday already exists on that date");
  }
  return ok(await withBranchNames(organizationId, inserted));
};

const findHoliday = async (organizationId: string, holidayId: string) => {
  const [holiday] = await db
    .select(columns)
    .from(holidaysTable)
    .where(and(eq(holidaysTable.id, holidayId), eq(holidaysTable.organizationId, organizationId)))
    .limit(1);
  return holiday ?? null;
};

export const updateHoliday = async (
  organizationId: string,
  requesterId: string,
  holidayId: string,
  input: z.infer<typeof updateHolidaySchema>,
): Promise<ServiceResult<Holiday>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const existing = await findHoliday(organizationId, holidayId);
  if (!existing) return fail("not-found", "Holiday not found");
  if (!canEditHoliday(access.data, existing.branchId)) return fail("forbidden");

  const [holiday] = await db
    .update(holidaysTable)
    .set({ name: input.name })
    .where(and(eq(holidaysTable.id, holidayId), eq(holidaysTable.organizationId, organizationId)))
    .returning(columns);
  if (!holiday) return fail("not-found", "Holiday not found");
  const [named] = await withBranchNames(organizationId, [holiday]);
  return ok(named!);
};

export const deleteHoliday = async (
  organizationId: string,
  requesterId: string,
  holidayId: string,
): Promise<ServiceResult<null>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;
  const existing = await findHoliday(organizationId, holidayId);
  if (!existing) return fail("not-found", "Holiday not found");
  if (!canEditHoliday(access.data, existing.branchId)) return fail("forbidden");

  const deleted = await db
    .delete(holidaysTable)
    .where(and(eq(holidaysTable.id, holidayId), eq(holidaysTable.organizationId, organizationId)))
    .returning({ id: holidaysTable.id });
  return deleted.length > 0 ? ok(null) : fail("not-found", "Holiday not found");
};
