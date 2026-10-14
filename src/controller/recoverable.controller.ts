import {
  createRecoverable,
  createRepayment,
  getRecoverable,
  listRecoverables,
  listRepayments,
  listAllRepayments,
  reviewRepayment,
  updateRecoverableStatus,
} from "@/services/recoverable.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import { getLoanNoc, requestLoanNocEmail, requestLoanNocWhatsApp } from "@/services/loan-noc.services";
import {
  createRecoverableSchema,
  createRepaymentSchema,
  listRecoverablesQuerySchema,
  reviewRepaymentSchema,
  updateRecoverableStatusSchema,
} from "@/validator/recoverable.validator";

export const createRecoverableController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createRecoverableSchema, async (body) =>
    respond(c, await createRecoverable(organizationId, userId, body), "Request created", 201),
  ),
);

export const listRecoverablesController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listRecoverablesQuerySchema, async (query) =>
    respond(c, await listRecoverables(organizationId, userId, query), "Records fetched"),
  ),
);

export const getRecoverableController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "recoverableId", async (id) =>
    respond(c, await getRecoverable(organizationId, userId, id), "Record fetched"),
  ),
);

export const requestLoanNocWhatsAppController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "recoverableId", async (id) =>
    respond(c, await requestLoanNocWhatsApp(organizationId, userId, id), "NOC is being sent on WhatsApp"),
  ),
);

export const requestLoanNocEmailController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "recoverableId", async (id) =>
    respond(c, await requestLoanNocEmail(organizationId, userId, id), "NOC is being sent by email"),
  ),
);

export const getLoanNocController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "recoverableId", async (id) =>
    respond(c, await getLoanNoc(organizationId, userId, id), "NOC generated"),
  ),
);

export const updateRecoverableStatusController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "recoverableId", (id) =>
    withBody(c, updateRecoverableStatusSchema, async (body) =>
      respond(
        c,
        await updateRecoverableStatus(organizationId, userId, id, body),
        "Status updated",
      ),
    ),
  ),
);

export const listAllRepaymentsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listAllRepayments(organizationId, userId), "Repayments fetched"),
);

export const listRepaymentsController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "recoverableId", async (id) =>
    respond(c, await listRepayments(organizationId, userId, id), "Repayments fetched"),
  ),
);

export const reviewRepaymentController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "recoverableId", (id) =>
    withParam(c, "repaymentId", (repaymentId) =>
      withBody(c, reviewRepaymentSchema, async (body) =>
        respond(
          c,
          await reviewRepayment(organizationId, userId, id, repaymentId, body),
          "Repayment reviewed",
        ),
      ),
    ),
  ),
);

export const createRepaymentController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "recoverableId", (id) =>
    withBody(c, createRepaymentSchema, async (body) =>
      respond(
        c,
        await createRepayment(organizationId, userId, id, body),
        "Repayment recorded",
        201,
      ),
    ),
  ),
);
