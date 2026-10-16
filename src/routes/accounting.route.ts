import { Hono } from "hono";

import {
  accountingSettingsController,
  exportJournalController,
  previewJournalController,
  saveAccountingSettingsController,
} from "@/controller/accounting.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

// Journal export for accounting software. Owners and admins of the whole organization.
const accountingRoutes: Hono = new Hono();

accountingRoutes.get("/settings", authenticate, accountingSettingsController);
accountingRoutes.put("/settings", authenticate, saveAccountingSettingsController);
accountingRoutes.get("/journal", authenticate, previewJournalController);
accountingRoutes.post("/journal/export", authenticate, exportJournalController);

export default accountingRoutes;
