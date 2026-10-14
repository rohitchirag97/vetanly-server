import { getBillingStatus, requestUpgrade, startTrial } from "@/services/billing-access.services";
import { withOrganization } from "@/utils/controller";
import { respond } from "@/utils/result";

export const billingStatusController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await getBillingStatus(organizationId, userId), "Billing status fetched"),
);

export const requestUpgradeController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await requestUpgrade(organizationId, userId), "Upgrade requested. We will contact you shortly."),
);

export const startTrialController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await startTrial(organizationId, userId), "Your 14-day free trial has started"),
);
