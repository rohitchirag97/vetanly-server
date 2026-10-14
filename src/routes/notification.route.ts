import { Hono } from "hono";

import {
  listNotificationsController,
  markReadController,
  unreadCountController,
} from "@/controller/notification.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const notificationRoutes: Hono = new Hono();

notificationRoutes.get("/", authenticate, listNotificationsController);
notificationRoutes.get("/unread-count", authenticate, unreadCountController);
notificationRoutes.post("/read", authenticate, markReadController);

export default notificationRoutes;
