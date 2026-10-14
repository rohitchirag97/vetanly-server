import { Hono } from "hono";

import { listOvertimeController, reviewOvertimeController } from "@/controller/overtime.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const overtimeRoutes: Hono = new Hono();

overtimeRoutes.get("/", authenticate, listOvertimeController);
overtimeRoutes.post("/review", authenticate, reviewOvertimeController);

export default overtimeRoutes;
