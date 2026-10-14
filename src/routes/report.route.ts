import { Hono } from "hono";

import { downloadReportController } from "@/controller/report.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const reportRoutes: Hono = new Hono();

reportRoutes.get("/download", authenticate, downloadReportController);

export default reportRoutes;
