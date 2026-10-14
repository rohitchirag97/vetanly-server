import {
  createLeaveRequest,
  createLeaveType,
  getLeaveBalances,
  listLeaveRequests,
  listLeaveTypes,
  updateLeaveStatus,
  updateLeaveType,
} from "@/services/leave.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  createLeaveRequestSchema,
  createLeaveTypeSchema,
  listLeaveQuerySchema,
  updateLeaveStatusSchema,
  updateLeaveTypeSchema,
} from "@/validator/leave.validator";

export const listLeaveTypesController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listLeaveTypes(organizationId, userId), "Leave types fetched"),
);

export const createLeaveTypeController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createLeaveTypeSchema, async (body) =>
    respond(c, await createLeaveType(organizationId, userId, body), "Leave type created", 201),
  ),
);

export const updateLeaveTypeController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "typeId", (id) =>
    withBody(c, updateLeaveTypeSchema, async (body) =>
      respond(c, await updateLeaveType(organizationId, userId, id, body), "Leave type updated"),
    ),
  ),
);

export const createLeaveRequestController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createLeaveRequestSchema, async (body) =>
    respond(c, await createLeaveRequest(organizationId, userId, body), "Leave requested", 201),
  ),
);

export const listLeaveRequestsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listLeaveQuerySchema, async (query) =>
    respond(c, await listLeaveRequests(organizationId, userId, query), "Leave requests fetched"),
  ),
);

export const updateLeaveStatusController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "requestId", (id) =>
    withBody(c, updateLeaveStatusSchema, async (body) =>
      respond(c, await updateLeaveStatus(organizationId, userId, id, body), "Leave request updated"),
    ),
  ),
);

export const leaveBalancesController = withOrganization(async (c, { organizationId, userId }) =>
  respond(
    c,
    await getLeaveBalances(organizationId, userId, new Date().getFullYear()),
    "Leave balances fetched",
  ),
);
