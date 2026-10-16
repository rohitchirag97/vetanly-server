import { Hono } from "hono";

import {
  attendanceInsightsController,
  costInsightsController,
  upcomingInsightsController,
  workforceInsightsController,
} from "@/controller/insights.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

// HR insights: owners, admins and HR (within their reach); payroll cost for owners and admins.
const insightsRoutes: Hono = new Hono();

insightsRoutes.get("/workforce", authenticate, workforceInsightsController);
insightsRoutes.get("/attendance", authenticate, attendanceInsightsController);
insightsRoutes.get("/upcoming", authenticate, upcomingInsightsController);
insightsRoutes.get("/cost", authenticate, costInsightsController);

export default insightsRoutes;
