import { Hono } from "hono";

import {
  createRecoverableController,
  createRepaymentController,
  getLoanNocController,
  getRecoverableController,
  requestLoanNocEmailController,
  requestLoanNocWhatsAppController,
  listRecoverablesController,
  listRepaymentsController,
  listAllRepaymentsController,
  reviewRepaymentController,
  updateRecoverableStatusController,
} from "@/controller/recoverable.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const recoverableRoutes: Hono = new Hono();

recoverableRoutes.get("/", authenticate, listRecoverablesController);
recoverableRoutes.get("/repayments", authenticate, listAllRepaymentsController);
recoverableRoutes.post("/", authenticate, createRecoverableController);
recoverableRoutes.get("/:recoverableId", authenticate, getRecoverableController);
recoverableRoutes.patch("/:recoverableId/status", authenticate, updateRecoverableStatusController);
recoverableRoutes.get("/:recoverableId/repayments", authenticate, listRepaymentsController);
recoverableRoutes.post("/:recoverableId/repayments", authenticate, createRepaymentController);
recoverableRoutes.get("/:recoverableId/noc", authenticate, getLoanNocController);
recoverableRoutes.post("/:recoverableId/noc/whatsapp", authenticate, requestLoanNocWhatsAppController);
recoverableRoutes.post("/:recoverableId/noc/email", authenticate, requestLoanNocEmailController);
recoverableRoutes.patch(
  "/:recoverableId/repayments/:repaymentId/review",
  authenticate,
  reviewRepaymentController,
);

export default recoverableRoutes;
