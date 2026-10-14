import { and, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import db from "@/utils/db";
import {
  notificationsTable as notifications,
  userOrganizationsTable,
  UserRole,
} from "@/drizzle/schema";
import { ALL_ROLES, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { ok, type ServiceResult } from "@/utils/result";

export type NotificationInput = {
  organizationId: string;
  userIds: string[];
  type: string;
  title: string;
  body?: string;
  link?: string;
};

/** Best effort: a failed notification must never break the action that triggered it. */
export const notify = async (input: NotificationInput) => {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return;
  try {
    await db.insert(notifications).values(
      userIds.map((userId) => ({
        organizationId: input.organizationId,
        userId,
        type: input.type,
        title: input.title.slice(0, 160),
        body: input.body?.slice(0, 500),
        link: input.link,
      })),
    );
  } catch (error) {
    console.error("Failed to create notification", error);
  }
};

/** Active admins and the super admin of an organization, optionally leaving one user out. */
export const managerIds = async (organizationId: string, exceptUserId?: string) => {
  const rows = await db
    .select({ userId: userOrganizationsTable.userId })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.isActive, true),
        inArray(userOrganizationsTable.role, [UserRole.SUPER_ADMIN, UserRole.ADMIN]),
      ),
    );
  return rows.map((row) => row.userId).filter((id) => id !== exceptUserId);
};

/** Active admins, HR managers, and the super admin for people-operation requests. */
export const peopleManagerIds = async (organizationId: string, exceptUserId?: string) => {
  const rows = await db
    .select({ userId: userOrganizationsTable.userId })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.isActive, true),
        inArray(userOrganizationsTable.role, [...PEOPLE_MANAGER_ROLES]),
      ),
    );
  return rows.map((row) => row.userId).filter((id) => id !== exceptUserId);
};
const columns = {
  id: notifications.id,
  type: notifications.type,
  title: notifications.title,
  body: notifications.body,
  link: notifications.link,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
};

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export const listNotifications = async (
  organizationId: string,
  userId: string,
  query: { limit: number; before?: string; unreadOnly: boolean },
): Promise<ServiceResult<{ items: NotificationItem[]; nextCursor: string | null }>> => {
  const access = await requireRole(organizationId, userId, ALL_ROLES);
  if (!access.ok) return access;

  const rows = await db
    .select(columns)
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, organizationId),
        eq(notifications.userId, userId),
        query.before ? lt(notifications.createdAt, new Date(query.before)) : undefined,
        query.unreadOnly ? isNull(notifications.readAt) : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  return ok({
    items: page,
    nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
  });
};

export const unreadCount = async (
  organizationId: string,
  userId: string,
): Promise<ServiceResult<{ count: number }>> => {
  const access = await requireRole(organizationId, userId, ALL_ROLES);
  if (!access.ok) return access;
  const [row] = await db
    .select({ value: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, organizationId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    );
  return ok({ count: row?.value ?? 0 });
};

export const markRead = async (
  organizationId: string,
  userId: string,
  ids: string[] | "all",
): Promise<ServiceResult<null>> => {
  const access = await requireRole(organizationId, userId, ALL_ROLES);
  if (!access.ok) return access;
  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.organizationId, organizationId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids === "all" ? undefined : inArray(notifications.id, ids),
      ),
    );
  return ok(null);
};

/** Drops read notifications older than 90 days so the table stays small. */
export const pruneNotifications = async () => {
  await db
    .delete(notifications)
    .where(
      and(
        sql`${notifications.readAt} is not null`,
        lt(notifications.createdAt, sql`now() - interval '90 days'`),
      ),
    );
};
