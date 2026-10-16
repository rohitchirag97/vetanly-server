import { Hono } from "hono";

import {
  approveBonusController,
  calculateBonusController,
  deleteBonusRunController,
  getBonusRunController,
  gratuityLiabilityController,
  listBonusRunsController,
  markBonusPaidController,
  updateBonusItemController,
} from "@/controller/bonus.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

// Statutory bonus runs (one per financial year) and the gratuity liability report. Owners and admins only.
const bonusRoutes: Hono = new Hono();

bonusRoutes.get("/gratuity", authenticate, gratuityLiabilityController);
bonusRoutes.get("/runs", authenticate, listBonusRunsController);
bonusRoutes.post("/runs", authenticate, calculateBonusController);
bonusRoutes.get("/runs/:runId", authenticate, getBonusRunController);
bonusRoutes.delete("/runs/:runId", authenticate, deleteBonusRunController);
bonusRoutes.patch("/runs/:runId/items/:itemId", authenticate, updateBonusItemController);
bonusRoutes.post("/runs/:runId/approve", authenticate, approveBonusController);
bonusRoutes.post("/runs/:runId/paid", authenticate, markBonusPaidController);

export default bonusRoutes;
