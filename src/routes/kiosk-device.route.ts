import { Hono } from "hono";

import {
  createKioskController,
  kioskHeartbeatController,
  listKiosksController,
  rotateKioskKeyController,
  updateKioskController,
} from "@/controller/kiosk-attendance.controller";
import { authenticate } from "@/middleware/authenticate.middleware";
import { authenticateKioskMiddleware } from "@/middleware/authenticate-kiosk.middleware";

const kioskRoutes: Hono = new Hono();

kioskRoutes.post("/heartbeat", authenticateKioskMiddleware, kioskHeartbeatController);
kioskRoutes.get("/", authenticate, listKiosksController);
kioskRoutes.post("/", authenticate, createKioskController);
kioskRoutes.patch("/:kioskId", authenticate, updateKioskController);
kioskRoutes.post("/:kioskId/rotate-key", authenticate, rotateKioskKeyController);

export default kioskRoutes;
