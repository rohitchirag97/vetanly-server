import {
  getMessagingOverview,
  listMessageLogs,
  removeProvider,
  requestAddon,
  requestTopUp,
  saveCustomProvider,
  saveLowBalanceThreshold,
  saveTemplateMapping,
  useVetanlyProvider,
} from "@/services/messaging.services";
import { sendTestMessage } from "@/services/messaging-delivery";
import { withBody, withOrganization, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  customProviderSchema,
  listMessageLogsSchema,
  lowBalanceSchema,
  templateMappingSchema,
  testMessageSchema,
  topUpRequestSchema,
} from "@/validator/messaging.validator";

export const messagingOverviewController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await getMessagingOverview(organizationId, userId), "Messaging settings fetched"),
);

export const requestAddonController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await requestAddon(organizationId, userId), "Add-on requested. We'll turn it on shortly."),
);

export const useVetanlyProviderController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await useVetanlyProvider(organizationId, userId), "WhatsApp will be sent through Vetanly"),
);

export const saveCustomProviderController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, customProviderSchema, async (body) => respond(c, await saveCustomProvider(organizationId, userId, body), "Provider saved")),
);

export const removeProviderController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await removeProvider(organizationId, userId), "WhatsApp provider removed"),
);

export const saveTemplatesController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, templateMappingSchema, async (body) => respond(c, await saveTemplateMapping(organizationId, userId, body), "Template mapping saved")),
);

export const sendTestController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, testMessageSchema, async (body) => respond(c, await sendTestMessage(organizationId, userId, body.phone), "Test message processed")),
);

export const lowBalanceController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, lowBalanceSchema, async (body) => respond(c, await saveLowBalanceThreshold(organizationId, userId, body), "Low-balance warning saved")),
);

export const topUpRequestController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, topUpRequestSchema, async (body) =>
    respond(c, await requestTopUp(organizationId, userId, body), "Top-up requested. We'll add the balance once payment is received.", 201),
  ),
);

export const messageLogsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listMessageLogsSchema, async (query) => respond(c, await listMessageLogs(organizationId, userId, query), "Message log fetched")),
);
