import { Hono } from "hono";

import { onboardingStatusController } from "@/controller/onboarding.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const onboardingRoutes: Hono = new Hono();

onboardingRoutes.get("/status", authenticate, onboardingStatusController);

export default onboardingRoutes;
