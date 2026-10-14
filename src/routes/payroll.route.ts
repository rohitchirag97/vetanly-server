import { Hono } from "hono";

import {
  deleteRunController,
  finalizeRunController,
  generateRunController,
  getRunController,
  getSlipController,
  listRunsController,
  mySlipsController,
  slipEmailController,
  slipWhatsAppController,
} from "@/controller/payroll-run.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const payrollRoutes: Hono = new Hono();

payrollRoutes.get("/slips/mine", authenticate, mySlipsController);
payrollRoutes.get("/slips/:itemId", authenticate, getSlipController);
payrollRoutes.post("/slips/:itemId/whatsapp", authenticate, slipWhatsAppController);
payrollRoutes.post("/slips/:itemId/email", authenticate, slipEmailController);
payrollRoutes.get("/", authenticate, listRunsController);
payrollRoutes.post("/generate", authenticate, generateRunController);
payrollRoutes.get("/:runId", authenticate, getRunController);
payrollRoutes.post("/:runId/finalize", authenticate, finalizeRunController);
payrollRoutes.delete("/:runId", authenticate, deleteRunController);

export default payrollRoutes;
