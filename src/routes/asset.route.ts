import { Hono } from "hono";

import {
  acknowledgeAssetController,
  assetHistoryController,
  assetStatusController,
  assignableEmployeesController,
  assignAssetController,
  createAssetController,
  deleteAssetController,
  employeeAssetsController,
  listAssetsController,
  myAssetsController,
  returnAssetController,
  updateAssetController,
} from "@/controller/asset.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

// Asset register (owners, admins, HR; branch managers for their branches) and employees' own assets.
const assetRoutes: Hono = new Hono();

assetRoutes.get("/mine", authenticate, myAssetsController);
assetRoutes.post("/assignments/:assignmentId/acknowledge", authenticate, acknowledgeAssetController);
assetRoutes.get("/employees", authenticate, assignableEmployeesController);
assetRoutes.get("/employee/:employeeId", authenticate, employeeAssetsController);
assetRoutes.get("/", authenticate, listAssetsController);
assetRoutes.post("/", authenticate, createAssetController);
assetRoutes.put("/:assetId", authenticate, updateAssetController);
assetRoutes.delete("/:assetId", authenticate, deleteAssetController);
assetRoutes.get("/:assetId/history", authenticate, assetHistoryController);
assetRoutes.post("/:assetId/assign", authenticate, assignAssetController);
assetRoutes.post("/:assetId/return", authenticate, returnAssetController);
assetRoutes.post("/:assetId/status", authenticate, assetStatusController);

export default assetRoutes;
