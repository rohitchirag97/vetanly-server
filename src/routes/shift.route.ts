import { Hono } from "hono";

import {
  createShiftController,
  deleteShiftController,
  listShiftsController,
  updateShiftController,
} from "@/controller/department-shift.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const shiftRoutes: Hono = new Hono();

shiftRoutes.get("/", authenticate, listShiftsController);
shiftRoutes.post("/", authenticate, createShiftController);
shiftRoutes.patch("/:shiftId", authenticate, updateShiftController);
shiftRoutes.delete("/:shiftId", authenticate, deleteShiftController);

export default shiftRoutes;
