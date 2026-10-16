import { Hono } from "hono";

import {
  branchManagersController,
  branchStatusController,
  createBranchController,
  listBranchesController,
  updateBranchController,
} from "@/controller/branch.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

// Branches and locations. Listing for owners, admins and HR; changes for owners and whole-organization admins.
const branchRoutes: Hono = new Hono();

branchRoutes.get("/", authenticate, listBranchesController);
branchRoutes.post("/", authenticate, createBranchController);
branchRoutes.put("/:branchId", authenticate, updateBranchController);
branchRoutes.patch("/:branchId/status", authenticate, branchStatusController);
branchRoutes.put("/:branchId/managers", authenticate, branchManagersController);

export default branchRoutes;
