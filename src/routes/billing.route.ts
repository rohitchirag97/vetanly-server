import { Hono } from "hono";

import { billingStatusController, requestUpgradeController, startTrialController } from "@/controller/billing.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const billingRoutes: Hono = new Hono();

billingRoutes.get("/status", authenticate, billingStatusController);
billingRoutes.post("/upgrade-request", authenticate, requestUpgradeController);
billingRoutes.post("/start-trial", authenticate, startTrialController);

export default billingRoutes;
