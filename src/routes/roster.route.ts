import { Hono } from "hono";

import {
  assignRotationController,
  cancelSwapController,
  createRotationController,
  deleteRotationController,
  endRotationController,
  listRotationsController,
  listSwapsController,
  myScheduleController,
  overrideController,
  requestSwapController,
  respondSwapController,
  reviewSwapController,
  rosterGridController,
  swapOptionsController,
  updateRotationController,
} from "@/controller/roster.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const rosterRoutes: Hono = new Hono();

// Managing rotations and the roster: HR, admins and the owner.
rosterRoutes.get("/rotations", authenticate, listRotationsController);
rosterRoutes.post("/rotations", authenticate, createRotationController);
rosterRoutes.put("/rotations/:rotationId", authenticate, updateRotationController);
rosterRoutes.delete("/rotations/:rotationId", authenticate, deleteRotationController);
rosterRoutes.post("/assign", authenticate, assignRotationController);
rosterRoutes.post("/end", authenticate, endRotationController);
rosterRoutes.get("/grid", authenticate, rosterGridController);
rosterRoutes.put("/override", authenticate, overrideController);
rosterRoutes.get("/swaps", authenticate, listSwapsController);
rosterRoutes.patch("/swaps/:swapId/review", authenticate, reviewSwapController);

// Every employee: their own schedule and shift swaps.
rosterRoutes.get("/mine", authenticate, myScheduleController);
rosterRoutes.get("/swap-options", authenticate, swapOptionsController);
rosterRoutes.post("/swaps", authenticate, requestSwapController);
rosterRoutes.patch("/swaps/:swapId/respond", authenticate, respondSwapController);
rosterRoutes.post("/swaps/:swapId/cancel", authenticate, cancelSwapController);

export default rosterRoutes;
