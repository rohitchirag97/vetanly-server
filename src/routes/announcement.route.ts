import { Hono } from "hono";

import {
  createAnnouncementController,
  deleteAnnouncementController,
  listAnnouncementsController,
} from "@/controller/announcement.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const announcementRoutes: Hono = new Hono();

announcementRoutes.get("/", authenticate, listAnnouncementsController);
announcementRoutes.post("/", authenticate, createAnnouncementController);
announcementRoutes.delete("/:announcementId", authenticate, deleteAnnouncementController);

export default announcementRoutes;
