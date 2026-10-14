import type { Context } from "hono";

import {
  deleteRun,
  finalizeRun,
  generateRun,
  getRun,
  getSlip,
  listMySlips,
  listRuns,
  requestSlipEmail,
  requestSlipWhatsApp,
} from "@/services/payroll.services";
import { withBody, withOrganization, withParam } from "@/utils/controller";
import { respond } from "@/utils/result";
import { generatePayrollSchema } from "@/validator/payroll.validator";

export const listRunsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listRuns(organizationId, userId), "Payroll runs fetched"),
);

export const getRunController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "runId", async (id) =>
    respond(c, await getRun(organizationId, userId, id), "Payroll run fetched"),
  ),
);

export const generateRunController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, generatePayrollSchema, async (body) =>
    respond(c, await generateRun(organizationId, userId, body), "Payroll calculated"),
  ),
);

export const deleteRunController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "runId", async (id) =>
    respond(c, await deleteRun(organizationId, userId, id), "Payroll run deleted"),
  ),
);

export const finalizeRunController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "runId", async (id) =>
    respond(c, await finalizeRun(organizationId, userId, id), "Payroll finalized"),
  ),
);

export const mySlipsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listMySlips(organizationId, userId), "Salary slips fetched"),
);

export const slipWhatsAppController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "itemId", async (id) =>
    respond(c, await requestSlipWhatsApp(organizationId, userId, id), "Salary slip is being sent on WhatsApp"),
  ),
);

export const slipEmailController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "itemId", async (id) =>
    respond(c, await requestSlipEmail(organizationId, userId, id), "Salary slip is being sent by email"),
  ),
);

export const getSlipController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "itemId", async (id) =>
    respond(c, await getSlip(organizationId, userId, id), "Salary slip fetched"),
  ),
);
