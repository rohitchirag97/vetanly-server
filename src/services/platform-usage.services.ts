import { inArray, sql } from "drizzle-orm";

import db from "@/utils/db";
import { UserRole, userOrganizationsTable, userSessionsTable } from "@/drizzle/schema";

export type OrganizationUsage = {
  activeEmployees: number;
  totalEmployees: number;
  activeAdmins: number;
  totalAdmins: number;
  loginsLast30Days: number;
  lastSignInAt: Date | null;
};

/**
 * Returns aggregate-only usage. This is the sole platform query over organization
 * memberships and sessions; it never selects employee profile or business data.
 */
export const getOrganizationUsage = async (organizationIds?: string[]) => {
  if (organizationIds && organizationIds.length === 0) return new Map<string, OrganizationUsage>();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      organizationId: userOrganizationsTable.organizationId,
      activeEmployees: sql<number>`(count(distinct ${userOrganizationsTable.userId}) filter (where ${userOrganizationsTable.role} = ${UserRole.EMPLOYEE} and ${userOrganizationsTable.isActive} = true))::int`,
      totalEmployees: sql<number>`(count(distinct ${userOrganizationsTable.userId}) filter (where ${userOrganizationsTable.role} = ${UserRole.EMPLOYEE}))::int`,
      activeAdmins: sql<number>`(count(distinct ${userOrganizationsTable.userId}) filter (where ${userOrganizationsTable.role} in (${UserRole.ADMIN}, ${UserRole.SUPER_ADMIN}) and ${userOrganizationsTable.isActive} = true))::int`,
      totalAdmins: sql<number>`(count(distinct ${userOrganizationsTable.userId}) filter (where ${userOrganizationsTable.role} in (${UserRole.ADMIN}, ${UserRole.SUPER_ADMIN})))::int`,
      loginsLast30Days: sql<number>`(count(distinct ${userSessionsTable.userId}) filter (where ${userSessionsTable.createdAt} >= ${since}))::int`,
      lastSignInAt: sql<Date | null>`max(${userSessionsTable.createdAt})`,
    })
    .from(userOrganizationsTable)
    .leftJoin(userSessionsTable, sql`${userSessionsTable.userId} = ${userOrganizationsTable.userId}`)
    .where(organizationIds ? inArray(userOrganizationsTable.organizationId, organizationIds) : undefined)
    .groupBy(userOrganizationsTable.organizationId);

  return new Map(
    rows.map((row) => [
      row.organizationId,
      {
        activeEmployees: Number(row.activeEmployees ?? 0),
        totalEmployees: Number(row.totalEmployees ?? 0),
        activeAdmins: Number(row.activeAdmins ?? 0),
        totalAdmins: Number(row.totalAdmins ?? 0),
        loginsLast30Days: Number(row.loginsLast30Days ?? 0),
        lastSignInAt: row.lastSignInAt,
      },
    ]),
  );
};
