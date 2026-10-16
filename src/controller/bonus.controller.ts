import {
  approveBonusRun,
  calculateBonusRun,
  deleteBonusRun,
  getBonusRun,
  gratuityLiability,
  listBonusRuns,
  markBonusPaid,
  updateBonusItem,
} from "@/services/bonus.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import { calculateBonusSchema, gratuityQuerySchema, markBonusPaidSchema, updateBonusItemSchema } from "@/validator/bonus.validator";

export const listBonusRunsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listBonusRuns(organizationId, userId), "Bonus runs fetched"),
);

export const calculateBonusController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, calculateBonusSchema, async (body) => respond(c, await calculateBonusRun(organizationId, userId, body), "Bonus calculated")),
);

export const getBonusRunController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "runId", async (id) => respond(c, await getBonusRun(organizationId, userId, id), "Bonus run fetched")),
);

export const updateBonusItemController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "runId", (runId) =>
    withParam(c, "itemId", (itemId) =>
      withBody(c, updateBonusItemSchema, async (body) => respond(c, await updateBonusItem(organizationId, userId, runId, itemId, body), "Bonus updated")),
    ),
  ),
);

export const approveBonusController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "runId", async (id) => respond(c, await approveBonusRun(organizationId, userId, id), "Bonus approved")),
);

export const markBonusPaidController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "runId", (id) =>
    withBody(c, markBonusPaidSchema, async (body) => respond(c, await markBonusPaid(organizationId, userId, id, body), "Bonus marked paid")),
  ),
);

export const deleteBonusRunController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "runId", async (id) => respond(c, await deleteBonusRun(organizationId, userId, id), "Bonus run deleted")),
);

export const gratuityLiabilityController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, gratuityQuerySchema, async (query) =>
    respond(c, await gratuityLiability(organizationId, userId, query.asOf ?? new Date().toISOString().slice(0, 10)), "Gratuity liability fetched"),
  ),
);
