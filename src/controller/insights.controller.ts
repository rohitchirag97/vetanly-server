import { attendanceInsights, costInsights, upcomingInsights, workforceInsights } from "@/services/insights.services";
import { withOrganization, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import { insightsRangeSchema } from "@/validator/insights.validator";

export const workforceInsightsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await workforceInsights(organizationId, userId), "Workforce insights fetched"),
);

export const attendanceInsightsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, insightsRangeSchema, async (query) => respond(c, await attendanceInsights(organizationId, userId, query), "Attendance insights fetched")),
);

export const upcomingInsightsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await upcomingInsights(organizationId, userId), "Upcoming events fetched"),
);

export const costInsightsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await costInsights(organizationId, userId), "Payroll cost fetched"),
);
