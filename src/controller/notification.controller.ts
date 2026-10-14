import { listNotifications, markRead, unreadCount } from "@/services/notification.services";
import { withBody, withOrganization, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import { listNotificationsQuerySchema, markReadSchema } from "@/validator/notification.validator";

export const listNotificationsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listNotificationsQuerySchema, async (query) =>
    respond(c, await listNotifications(organizationId, userId, query), "Notifications fetched"),
  ),
);

export const unreadCountController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await unreadCount(organizationId, userId), "Unread count fetched"),
);

export const markReadController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, markReadSchema, async (body) =>
    respond(c, await markRead(organizationId, userId, body.ids), "Notifications updated"),
  ),
);
