import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";

import db from "@/utils/db";
import { announcementsTable, userOrganizationsTable, usersTable } from "@/drizzle/schema";
import { ALL_ROLES, PEOPLE_MANAGER_ROLES, requireRole } from "@/services/access.services";
import { notify } from "@/services/notification.services";
import { fail, ok, type ServiceResult } from "@/utils/result";
import type {
  createAnnouncementSchema,
  listAnnouncementsQuerySchema,
} from "@/validator/announcement.validator";

export type Announcement = {
  id: string;
  title: string;
  body: string;
  createdAt: Date;
  author: string | null;
};

const select = () =>
  db
    .select({
      id: announcementsTable.id,
      title: announcementsTable.title,
      body: announcementsTable.body,
      createdAt: announcementsTable.createdAt,
      fname: usersTable.fname,
      lname: usersTable.lname,
    })
    .from(announcementsTable)
    .leftJoin(usersTable, eq(usersTable.id, announcementsTable.createdByUserId));

const toItem = (row: Awaited<ReturnType<typeof select>>[number]): Announcement => ({
  id: row.id,
  title: row.title,
  body: row.body,
  createdAt: row.createdAt,
  author: row.fname ? `${row.fname} ${row.lname ?? ""}`.trim() : null,
});

export const listAnnouncements = async (
  organizationId: string,
  requesterId: string,
  query: z.infer<typeof listAnnouncementsQuerySchema>,
): Promise<ServiceResult<Announcement[]>> => {
  const access = await requireRole(organizationId, requesterId, ALL_ROLES);
  if (!access.ok) return access;

  const rows = await select()
    .where(eq(announcementsTable.organizationId, organizationId))
    .orderBy(desc(announcementsTable.createdAt))
    .limit(query.limit);
  return ok(rows.map(toItem));
};

export const createAnnouncement = async (
  organizationId: string,
  requesterId: string,
  input: z.infer<typeof createAnnouncementSchema>,
): Promise<ServiceResult<Announcement>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const [created] = await db
    .insert(announcementsTable)
    .values({ organizationId, title: input.title, body: input.body, createdByUserId: requesterId })
    .returning({ id: announcementsTable.id });
  if (!created) return fail("invalid", "Could not publish the announcement");

  const members = await db
    .select({ userId: userOrganizationsTable.userId })
    .from(userOrganizationsTable)
    .where(
      and(
        eq(userOrganizationsTable.organizationId, organizationId),
        eq(userOrganizationsTable.isActive, true),
      ),
    );
  await notify({
    organizationId,
    userIds: members.map((member) => member.userId).filter((id) => id !== requesterId),
    type: "announcement",
    title: input.title,
    body: input.body,
    link: "/announcements",
  });

  const [row] = await select().where(eq(announcementsTable.id, created.id));
  return ok(toItem(row!));
};

export const deleteAnnouncement = async (
  organizationId: string,
  requesterId: string,
  announcementId: string,
): Promise<ServiceResult<null>> => {
  const access = await requireRole(organizationId, requesterId, PEOPLE_MANAGER_ROLES);
  if (!access.ok) return access;

  const deleted = await db
    .delete(announcementsTable)
    .where(
      and(
        eq(announcementsTable.id, announcementId),
        eq(announcementsTable.organizationId, organizationId),
      ),
    )
    .returning({ id: announcementsTable.id });
  return deleted.length > 0 ? ok(null) : fail("not-found", "Announcement not found");
};
