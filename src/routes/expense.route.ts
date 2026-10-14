import { Hono } from "hono";

import {
  cancelClaimController,
  createClaimController,
  listClaimsController,
  myClaimsController,
  payClaimController,
  receiptUrlController,
  reviewClaimController,
} from "@/controller/expense.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const expenseRoutes: Hono = new Hono();

expenseRoutes.get("/mine", authenticate, myClaimsController);
expenseRoutes.get("/", authenticate, listClaimsController);
expenseRoutes.post("/", authenticate, createClaimController);
expenseRoutes.post("/:claimId/cancel", authenticate, cancelClaimController);
expenseRoutes.patch("/:claimId/review", authenticate, reviewClaimController);
expenseRoutes.post("/:claimId/paid", authenticate, payClaimController);
expenseRoutes.get("/:claimId/receipt", authenticate, receiptUrlController);

export default expenseRoutes;
