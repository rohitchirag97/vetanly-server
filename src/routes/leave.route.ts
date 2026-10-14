import { Hono } from "hono";

import {
  createLeaveRequestController,
  createLeaveTypeController,
  leaveBalancesController,
  listLeaveRequestsController,
  listLeaveTypesController,
  updateLeaveStatusController,
  updateLeaveTypeController,
} from "@/controller/leave.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const leaveRoutes: Hono = new Hono();

leaveRoutes.get("/types", authenticate, listLeaveTypesController);
leaveRoutes.post("/types", authenticate, createLeaveTypeController);
leaveRoutes.patch("/types/:typeId", authenticate, updateLeaveTypeController);
leaveRoutes.get("/balances", authenticate, leaveBalancesController);
leaveRoutes.get("/", authenticate, listLeaveRequestsController);
leaveRoutes.post("/", authenticate, createLeaveRequestController);
leaveRoutes.patch("/:requestId/status", authenticate, updateLeaveStatusController);

export default leaveRoutes;
