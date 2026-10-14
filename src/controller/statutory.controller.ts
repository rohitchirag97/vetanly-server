import {
  getStatutorySettings,
  listEmployeeStatutory,
  saveEmployeeStatutory,
  saveStatutorySettings,
} from "@/services/statutory.services";
import { withBody, withOrganization, withParam } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  updateEmployeeStatutorySchema,
  updateStatutorySettingsSchema,
} from "@/validator/statutory.validator";

export const getStatutorySettingsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await getStatutorySettings(organizationId, userId), "Statutory settings fetched"),
);

export const updateStatutorySettingsController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, updateStatutorySettingsSchema, async (body) =>
    respond(c, await saveStatutorySettings(organizationId, userId, body), "Statutory settings saved"),
  ),
);

export const listEmployeeStatutoryController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listEmployeeStatutory(organizationId, userId), "Statutory profiles fetched"),
);

export const updateEmployeeStatutoryController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withBody(c, updateEmployeeStatutorySchema, async (body) =>
      respond(
        c,
        await saveEmployeeStatutory(organizationId, userId, employeeId, body),
        "Statutory profile saved",
      ),
    ),
  ),
);
