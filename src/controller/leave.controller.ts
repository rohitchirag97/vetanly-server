import {
  createLeaveRequest,
  createLeaveType,
  getLeaveBalances,
  listLeaveRequests,
  listLeaveTypes,
  updateLeaveStatus,
  updateLeaveType,
} from "@/services/leave.services";
import {
  decideOffDayWork,
  listLeaveCredits,
  listOffDayWork,
  requestOffDayOutcome,
  revokeLeaveCredit,
} from "@/services/off-day-work.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  createLeaveRequestSchema,
  createLeaveTypeSchema,
  decideOffDayWorkSchema,
  leaveCreditQuerySchema,
  offDayWorkQuerySchema,
  requestOffDayOutcomeSchema,
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

export const listLeaveCreditsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, leaveCreditQuerySchema, async (query) =>
    respond(c, await listLeaveCredits(organizationId, userId, query), "Leave credits fetched"),
  ),
);

export const revokeLeaveCreditController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "creditId", async (id) => respond(c, await revokeLeaveCredit(organizationId, userId, id), "Credit removed")),
);

export const listOffDayWorkController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, offDayWorkQuerySchema, async (query) =>
    respond(c, await listOffDayWork(organizationId, userId, query), "Work on off days fetched"),
  ),
);

export const requestOffDayOutcomeController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, requestOffDayOutcomeSchema, async (body) =>
    respond(c, await requestOffDayOutcome(organizationId, userId, body), "Request sent"),
  ),
);

export const decideOffDayWorkController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, decideOffDayWorkSchema, async (body) =>
    respond(c, await decideOffDayWork(organizationId, userId, body), "Decision saved"),
  ),
);
