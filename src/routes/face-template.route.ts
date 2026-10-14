import { Hono } from "hono";

import {
  enrollFaceTemplateController,
  kioskDeviceInfoController,
  listEmployeeTemplatesController,
  revokeEmployeeTemplatesController,
  syncFaceTemplatesController,
} from "@/controller/face-template.controller";
import { authenticate } from "@/middleware/authenticate.middleware";
import { authenticateKioskMiddleware } from "@/middleware/authenticate-kiosk.middleware";

const faceTemplateRoutes: Hono = new Hono();

faceTemplateRoutes.post("/enroll", authenticateKioskMiddleware, enrollFaceTemplateController);
faceTemplateRoutes.get("/sync", authenticateKioskMiddleware, syncFaceTemplatesController);
faceTemplateRoutes.post("/device-info", authenticateKioskMiddleware, kioskDeviceInfoController);
faceTemplateRoutes.get("/employee/:employeeId", authenticate, listEmployeeTemplatesController);
faceTemplateRoutes.delete("/employee/:employeeId", authenticate, revokeEmployeeTemplatesController);

export default faceTemplateRoutes;
