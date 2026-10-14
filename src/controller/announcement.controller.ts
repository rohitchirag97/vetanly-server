import {
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
} from "@/services/announcement.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  createAnnouncementSchema,
  listAnnouncementsQuerySchema,
} from "@/validator/announcement.validator";

export const listAnnouncementsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listAnnouncementsQuerySchema, async (query) =>
    respond(c, await listAnnouncements(organizationId, userId, query), "Announcements fetched"),
  ),
);

export const createAnnouncementController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createAnnouncementSchema, async (body) =>
    respond(c, await createAnnouncement(organizationId, userId, body), "Announcement published", 201),
  ),
);

export const deleteAnnouncementController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "announcementId", async (id) =>
    respond(c, await deleteAnnouncement(organizationId, userId, id), "Announcement deleted"),
  ),
);
