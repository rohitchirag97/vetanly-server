import type { Context } from "hono";

import {
  cancelClaim,
  createClaim,
  getReceiptUrl,
  listClaims,
  listMyClaims,
  markClaimPaid,
  reviewClaim,
} from "@/services/expense.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { badRequest, firstIssue } from "@/utils/request";
import { respond } from "@/utils/result";
import {
  createExpenseClaimSchema,
  listExpenseClaimsQuerySchema,
  payExpenseClaimSchema,
  reviewExpenseClaimSchema,
} from "@/validator/expense.validator";

export const myClaimsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listMyClaims(organizationId, userId), "Expense claims fetched"),
);

export const listClaimsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listExpenseClaimsQuerySchema, async (query) =>
    respond(c, await listClaims(organizationId, userId, query), "Expense claims fetched"),
  ),
);

// Multipart form: the claim fields plus an optional receipt file.
export const createClaimController = withOrganization(async (c: Context, { organizationId, userId }) => {
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return badRequest(c, "Fill in the claim form");
  const fields = createExpenseClaimSchema.safeParse({
    category: form.category,
    amount: form.amount,
    expenseDate: form.expenseDate,
    description: form.description,
  });
  if (!fields.success) return badRequest(c, firstIssue(fields.error));
  const receipt = form.receipt instanceof File ? form.receipt : null;
  return respond(c, await createClaim(organizationId, userId, fields.data, receipt), "Expense claim submitted", 201);
});

export const cancelClaimController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "claimId", async (id) => respond(c, await cancelClaim(organizationId, userId, id), "Claim cancelled")),
);

export const reviewClaimController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "claimId", (id) =>
    withBody(c, reviewExpenseClaimSchema, async (body) =>
      respond(c, await reviewClaim(organizationId, userId, id, body), `Claim ${body.status}`),
    ),
  ),
);

export const payClaimController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "claimId", (id) =>
    withBody(c, payExpenseClaimSchema, async (body) =>
      respond(c, await markClaimPaid(organizationId, userId, id, body.note), "Claim marked paid"),
    ),
  ),
);

export const receiptUrlController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "claimId", async (id) => respond(c, await getReceiptUrl(organizationId, userId, id), "Receipt link created")),
);
