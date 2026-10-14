import { Hono } from "hono";

import {
  listAuditLogsController,
  verifyAuditChainController,
} from "@/controller/audit.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

// Read-only by design: there is no create, update or delete endpoint.
const auditRoutes: Hono = new Hono();

auditRoutes.get("/", authenticate, listAuditLogsController);
auditRoutes.get("/verify", authenticate, verifyAuditChainController);

export default auditRoutes;
