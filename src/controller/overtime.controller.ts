import { listOvertime, reviewOvertime } from "@/services/overtime.services";
import { withBody, withOrganization, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import { listOvertimeQuerySchema, reviewOvertimeSchema } from "@/validator/overtime.validator";

export const listOvertimeController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listOvertimeQuerySchema, async (query) =>
    respond(c, await listOvertime(organizationId, userId, query), "Overtime fetched"),
  ),
);

export const reviewOvertimeController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, reviewOvertimeSchema, async (body) =>
    respond(c, await reviewOvertime(organizationId, userId, body), "Overtime updated"),
  ),
);
