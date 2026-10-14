import { getOnboardingStatus } from "@/services/onboarding.services";
import { withOrganization } from "@/utils/controller";
import { respond } from "@/utils/result";

export const onboardingStatusController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await getOnboardingStatus(organizationId, userId), "Onboarding status fetched"),
);
