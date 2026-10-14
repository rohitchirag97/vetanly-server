import { Hono } from "hono";

import {
  getPayrollSettingsController,
  savePayrollSettingsController,
} from "@/controller/payroll.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const payrollSettingsRoutes: Hono = new Hono();

payrollSettingsRoutes.get("/", authenticate, getPayrollSettingsController);
payrollSettingsRoutes.put("/", authenticate, savePayrollSettingsController);

export default payrollSettingsRoutes;
