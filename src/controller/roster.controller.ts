import {
  assignRotation,
  cancelSwap,
  deleteRotation,
  endRotation,
  getMySchedule,
  getRosterGrid,
  getSwapOptions,
  listRotations,
  listSwapsForReview,
  requestSwap,
  respondToSwap,
  reviewSwap,
  saveRotation,
  setRosterOverride,
} from "@/services/roster.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  assignRotationSchema,
  endRotationSchema,
  overrideSchema,
  rangeQuerySchema,
  rotationSchema,
  swapDecisionSchema,
  swapListQuerySchema,
  swapOptionsQuerySchema,
  swapRequestSchema,
  swapReviewSchema,
} from "@/validator/roster.validator";

export const listRotationsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listRotations(organizationId, userId), "Rotations fetched"),
);

export const createRotationController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, rotationSchema, async (body) =>
    respond(c, await saveRotation(organizationId, userId, null, body), "Rotation created", 201),
  ),
);

export const updateRotationController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "rotationId", (id) =>
    withBody(c, rotationSchema, async (body) => respond(c, await saveRotation(organizationId, userId, id, body), "Rotation updated")),
  ),
);

export const deleteRotationController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "rotationId", async (id) => respond(c, await deleteRotation(organizationId, userId, id), "Rotation deleted")),
);

export const assignRotationController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, assignRotationSchema, async (body) => respond(c, await assignRotation(organizationId, userId, body), "Rotation assigned")),
);

export const endRotationController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, endRotationSchema, async (body) => respond(c, await endRotation(organizationId, userId, body), "Rotation ended")),
);

export const rosterGridController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, rangeQuerySchema, async (query) => respond(c, await getRosterGrid(organizationId, userId, query), "Roster fetched")),
);

export const overrideController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, overrideSchema, async (body) => respond(c, await setRosterOverride(organizationId, userId, body), "Roster updated")),
);

export const myScheduleController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, rangeQuerySchema, async (query) => respond(c, await getMySchedule(organizationId, userId, query), "Schedule fetched")),
);

export const swapOptionsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, swapOptionsQuerySchema, async ({ date }) =>
    respond(c, await getSwapOptions(organizationId, userId, date), "Options fetched"),
  ),
);

export const requestSwapController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, swapRequestSchema, async (body) => respond(c, await requestSwap(organizationId, userId, body), "Swap requested", 201)),
);

export const respondSwapController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "swapId", (id) =>
    withBody(c, swapDecisionSchema, async ({ accept }) =>
      respond(c, await respondToSwap(organizationId, userId, id, accept), accept ? "Swap accepted" : "Swap declined"),
    ),
  ),
);

export const cancelSwapController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "swapId", async (id) => respond(c, await cancelSwap(organizationId, userId, id), "Swap cancelled")),
);

export const listSwapsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, swapListQuerySchema, async ({ status }) =>
    respond(c, await listSwapsForReview(organizationId, userId, status), "Swaps fetched"),
  ),
);

export const reviewSwapController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "swapId", (id) =>
    withBody(c, swapReviewSchema, async (body) =>
      respond(c, await reviewSwap(organizationId, userId, id, body), body.approve ? "Swap approved" : "Swap rejected"),
    ),
  ),
);
