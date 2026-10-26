import {
  createRegularization,
  editAttendance,
  listRegularizations,
  updateRegularizationStatus,
} from "@/services/regularization.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  createRegularizationSchema,
  editAttendanceSchema,
  listRegularizationQuerySchema,
  updateRegularizationStatusSchema,
} from "@/validator/regularization.validator";

export const createRegularizationController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createRegularizationSchema, async (body) =>
    respond(c, await createRegularization(organizationId, userId, body), "Correction requested", 201),
  ),
);

export const listRegularizationsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listRegularizationQuerySchema, async (query) =>
    respond(c, await listRegularizations(organizationId, userId, query), "Corrections fetched"),
  ),
);

export const updateRegularizationStatusController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "requestId", (id) =>
    withBody(c, updateRegularizationStatusSchema, async (body) =>
      respond(
        c,
        await updateRegularizationStatus(organizationId, userId, id, body),
        "Correction updated",
      ),
    ),
  ),
);

export const editAttendanceController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, editAttendanceSchema, async (body) =>
    respond(c, await editAttendance(organizationId, userId, body), "Attendance updated", 201),
  ),
);
