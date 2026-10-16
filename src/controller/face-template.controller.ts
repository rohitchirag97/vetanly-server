import type { Context } from "hono";

import {
  enrollFaceTemplate,
  listEmployeeTemplates,
  listKioskEmployees,
  revokeEmployeeTemplates,
  syncFaceTemplates,
  updateKioskDeviceInfo,
} from "@/services/face-template.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { ok, respond } from "@/utils/result";
import {
  enrollFaceTemplateSchema,
  kioskDeviceInfoSchema,
  syncFaceTemplatesQuerySchema,
} from "@/validator/face-template.validator";

export const enrollFaceTemplateController = (c: Context) =>
  withBody(c, enrollFaceTemplateSchema, async (body) =>
    respond(c, await enrollFaceTemplate(c.get("kiosk"), body), "Face template enrolled", 201),
  );

export const syncFaceTemplatesController = (c: Context) =>
  withQuery(c, syncFaceTemplatesQuerySchema, async (query) =>
    respond(c, await syncFaceTemplates(c.get("kiosk"), query), "Face templates fetched"),
  );

export const listKioskEmployeesController = async (c: Context) =>
  respond(c, await listKioskEmployees(c.get("kiosk")), "Employees fetched");

export const kioskDeviceInfoController = (c: Context) =>
  withBody(c, kioskDeviceInfoSchema, async (body) => {
    await updateKioskDeviceInfo(c.get("kiosk"), body);
    return respond(c, ok({ updated: true }), "Device info updated");
  });

export const listEmployeeTemplatesController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (employeeId) =>
    respond(
      c,
      await listEmployeeTemplates(organizationId, userId, employeeId),
      "Face templates fetched",
    ),
  ),
);

export const revokeEmployeeTemplatesController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (employeeId) =>
    respond(
      c,
      await revokeEmployeeTemplates(organizationId, userId, employeeId),
      "Face templates revoked",
    ),
  ),
);
