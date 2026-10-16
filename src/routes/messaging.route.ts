import { Hono } from "hono";

import {
  lowBalanceController,
  messageLogsController,
  messagingOverviewController,
  removeProviderController,
  requestAddonController,
  saveCustomProviderController,
  saveTemplatesController,
  sendTestController,
  topUpRequestController,
  useVetanlyProviderController,
} from "@/controller/messaging.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

// Report delivery add-on: owners manage it; owners and admins read the overview and the log.
const messagingRoutes: Hono = new Hono();

messagingRoutes.get("/", authenticate, messagingOverviewController);
messagingRoutes.get("/logs", authenticate, messageLogsController);
messagingRoutes.post("/addon-request", authenticate, requestAddonController);
messagingRoutes.put("/provider/vetanly", authenticate, useVetanlyProviderController);
messagingRoutes.put("/provider/custom", authenticate, saveCustomProviderController);
messagingRoutes.delete("/provider", authenticate, removeProviderController);
messagingRoutes.put("/templates", authenticate, saveTemplatesController);
messagingRoutes.post("/test", authenticate, sendTestController);
messagingRoutes.put("/low-balance", authenticate, lowBalanceController);
messagingRoutes.post("/top-up-requests", authenticate, topUpRequestController);

export default messagingRoutes;
