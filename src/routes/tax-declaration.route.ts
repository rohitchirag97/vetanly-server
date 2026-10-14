import { Hono } from "hono";

import {
  addItemController,
  deleteItemController,
  form12bbController,
  getSettingsController,
  listDeclarationsController,
  myDeclarationController,
  proofUrlController,
  reviewDetailController,
  reviewItemController,
  saveMyDeclarationController,
  saveSettingsController,
  updateItemController,
  uploadProofController,
} from "@/controller/tax-declaration.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const taxDeclarationRoutes: Hono = new Hono();

// The employee's own declaration.
taxDeclarationRoutes.get("/mine", authenticate, myDeclarationController);
taxDeclarationRoutes.put("/mine", authenticate, saveMyDeclarationController);
taxDeclarationRoutes.post("/mine/items", authenticate, addItemController);
taxDeclarationRoutes.patch("/items/:itemId", authenticate, updateItemController);
taxDeclarationRoutes.delete("/items/:itemId", authenticate, deleteItemController);
taxDeclarationRoutes.post("/items/:itemId/proof", authenticate, uploadProofController);
taxDeclarationRoutes.get("/items/:itemId/proof", authenticate, proofUrlController);

// Reviewers (owner, admins, HR for employees) and settings.
taxDeclarationRoutes.get("/settings", authenticate, getSettingsController);
taxDeclarationRoutes.put("/settings", authenticate, saveSettingsController);
taxDeclarationRoutes.patch("/items/:itemId/review", authenticate, reviewItemController);
taxDeclarationRoutes.get("/", authenticate, listDeclarationsController);
taxDeclarationRoutes.get("/:declarationId/form-12bb", authenticate, form12bbController);
taxDeclarationRoutes.get("/:declarationId", authenticate, reviewDetailController);

export default taxDeclarationRoutes;
