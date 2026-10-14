import { listAuditLogs, verifyAuditChain } from "@/services/audit.services";
import { withOrganization, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import { listAuditLogsQuerySchema } from "@/validator/audit.validator";

export const listAuditLogsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listAuditLogsQuerySchema, async (query) =>
    respond(c, await listAuditLogs(organizationId, userId, query), "Audit log fetched"),
  ),
);

export const verifyAuditChainController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await verifyAuditChain(organizationId, userId), "Audit log verified"),
);
