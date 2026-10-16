import { Hono } from "hono";

import {
  claimPairingCodeController,
  createEnrollmentCodeController,
  createKioskController,
  createPairingCodeController,
  unlockEnrollmentController,
  unpairKioskController,
  kioskHeartbeatController,
  listKiosksController,
  rotateKioskKeyController,
  updateKioskController,
} from "@/controller/kiosk-attendance.controller";
import { authenticate } from "@/middleware/authenticate.middleware";
import { authenticateKioskMiddleware } from "@/middleware/authenticate-kiosk.middleware";

const kioskRoutes: Hono = new Hono();

kioskRoutes.post("/heartbeat", authenticateKioskMiddleware, kioskHeartbeatController);
kioskRoutes.post("/pair", claimPairingCodeController);
kioskRoutes.post("/:kioskId/pairing-code", authenticate, createPairingCodeController);
kioskRoutes.post("/:kioskId/unpair", authenticate, unpairKioskController);
kioskRoutes.post("/:kioskId/enrollment-code", authenticate, createEnrollmentCodeController);
kioskRoutes.post("/enrollment/unlock", authenticateKioskMiddleware, unlockEnrollmentController);
kioskRoutes.get("/", authenticate, listKiosksController);
kioskRoutes.post("/", authenticate, createKioskController);
kioskRoutes.patch("/:kioskId", authenticate, updateKioskController);
kioskRoutes.post("/:kioskId/rotate-key", authenticate, rotateKioskKeyController);

export default kioskRoutes;
