import { Hono } from "hono";

import {
  cancelDraftController,
  finalizeController,
  getSettlementController,
  listSettlementsController,
  markPaidController,
  saveDraftController,
  statementController,
} from "@/controller/settlement.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

// Full & final settlements, keyed by the leaving employee. Owners and admins only.
const settlementRoutes: Hono = new Hono();

settlementRoutes.get("/", authenticate, listSettlementsController);
settlementRoutes.get("/:employeeId", authenticate, getSettlementController);
settlementRoutes.put("/:employeeId", authenticate, saveDraftController);
settlementRoutes.delete("/:employeeId", authenticate, cancelDraftController);
settlementRoutes.post("/:employeeId/finalize", authenticate, finalizeController);
settlementRoutes.post("/:employeeId/paid", authenticate, markPaidController);
settlementRoutes.get("/:employeeId/statement", authenticate, statementController);

export default settlementRoutes;
