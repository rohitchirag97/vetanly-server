import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import { holidaysTable } from "@/drizzle/schema";
import { ALL_ROLES, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { eachDate } from "@/services/payroll-calc";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  createHolidaySchema,
  listHolidaysQuerySchema,
  updateHolidaySchema,
} from "@/validator/holiday.validator";

export type Holiday = { id: string; date: string; name: string };

const columns = {
  id: holidaysTable.id,
  date: holidaysTable.date,
  name: holidaysTable.name,
};

export const holidayDatesBetween = async (
  organizationId: string,
  from: string,
  to: string,
): Promise<string[]> => {
  const rows = await db
    .select({ date: holidaysTable.date })
    .from(holidaysTable)
    .where(
      and(
        eq(holidaysTable.organizationId, organizationId),
        gte(holidaysTable.date, from),
        lte(holidaysTable.date, to),
      ),
    );
  return rows.map((row) => row.date);
};

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

  return ok(
    await db
      .select(columns)
      .from(holidaysTable)
      .where(and(...conditions))
      .orderBy(asc(holidaysTable.date))
      .limit(500),
  );
};

export const createHoliday = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createHolidaySchema>,
): Promise<ServiceResult<Holiday[]>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const dates = eachDate(input.date, input.endDate ?? input.date);
  const inserted = await db
    .insert(holidaysTable)
    .values(dates.map((date) => ({ organizationId, date, name: input.name })))
    .onConflictDoNothing({ target: [holidaysTable.organizationId, holidaysTable.date] })
    .returning(columns);

  if (inserted.length === 0) {
    return fail("conflict", "A holiday already exists on that date");
  }
  return ok(inserted);
};

export const updateHoliday = async (
  organizationId: string,
  requesterId: string,
  holidayId: string,
  input: z.infer<typeof updateHolidaySchema>,
): Promise<ServiceResult<Holiday>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const [holiday] = await db
    .update(holidaysTable)
    .set({ name: input.name })
    .where(and(eq(holidaysTable.id, holidayId), eq(holidaysTable.organizationId, organizationId)))
    .returning(columns);
  return holiday ? ok(holiday) : fail("not-found", "Holiday not found");
};

export const deleteHoliday = async (
  organizationId: string,
  requesterId: string,
  holidayId: string,
): Promise<ServiceResult<null>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const deleted = await db
    .delete(holidaysTable)
    .where(and(eq(holidaysTable.id, holidayId), eq(holidaysTable.organizationId, organizationId)))
    .returning({ id: holidaysTable.id });
  return deleted.length > 0 ? ok(null) : fail("not-found", "Holiday not found");
};
