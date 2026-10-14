import { Hono } from "hono";

import {
  getStatutorySettingsController,
  listEmployeeStatutoryController,
  updateEmployeeStatutoryController,
  updateStatutorySettingsController,
} from "@/controller/statutory.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const statutoryRoutes: Hono = new Hono();

statutoryRoutes.get("/settings", authenticate, getStatutorySettingsController);
statutoryRoutes.put("/settings", authenticate, updateStatutorySettingsController);
statutoryRoutes.get("/employees", authenticate, listEmployeeStatutoryController);
statutoryRoutes.put("/employees/:employeeId", authenticate, updateEmployeeStatutoryController);

export default statutoryRoutes;
