import { Hono } from "hono";

import {
  createRegularizationController,
  editAttendanceController,
  listRegularizationsController,
  updateRegularizationStatusController,
} from "@/controller/regularization.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const regularizationRoutes: Hono = new Hono();

regularizationRoutes.get("/", authenticate, listRegularizationsController);
regularizationRoutes.post("/", authenticate, createRegularizationController);
regularizationRoutes.post("/edit", authenticate, editAttendanceController);
regularizationRoutes.patch("/:requestId/status", authenticate, updateRegularizationStatusController);

export default regularizationRoutes;
