import {
  getEmployment,
  setOwnPayrollInclusion,
  updateEmployment,
} from "@/services/employment.services";
import {
  getPayrollSettings,
  savePayrollSettings,
} from "@/services/payroll-settings.services";
import { withBody, withOrganization, withParam } from "@/utils/controller";
import { respond } from "@/utils/result";
import { payrollInclusionSchema, updateEmploymentSchema } from "@/validator/employment.validator";
import { payrollSettingsSchema } from "@/validator/payroll-settings.validator";

export const getPayrollSettingsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await getPayrollSettings(organizationId, userId), "Payroll settings fetched"),
);

export const savePayrollSettingsController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, payrollSettingsSchema, async (body) =>
    respond(c, await savePayrollSettings(organizationId, userId, body), "Payroll settings saved"),
  ),
);

export const getEmploymentController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (id) =>
    respond(c, await getEmployment(organizationId, userId, id), "Employment details fetched"),
  ),
);

export const updateEmploymentController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (id) =>
    withBody(c, updateEmploymentSchema, async (body) =>
      respond(
        c,
        await updateEmployment(organizationId, userId, id, body),
        "Employment details updated",
      ),
    ),
  ),
);

export const updatePayrollInclusionController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, payrollInclusionSchema, async ({ includeInPayroll }) =>
    respond(
      c,
      await setOwnPayrollInclusion(organizationId, userId, includeInPayroll),
      "Payroll inclusion updated",
    ),
  ),
);
