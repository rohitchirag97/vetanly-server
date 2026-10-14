import { Hono } from "hono";

import {
  createRegularizationController,
  listRegularizationsController,
  updateRegularizationStatusController,
} from "@/controller/regularization.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const regularizationRoutes: Hono = new Hono();

regularizationRoutes.get("/", authenticate, listRegularizationsController);
regularizationRoutes.post("/", authenticate, createRegularizationController);
regularizationRoutes.patch("/:requestId/status", authenticate, updateRegularizationStatusController);

export default regularizationRoutes;
