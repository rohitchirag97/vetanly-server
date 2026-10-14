import type { Context } from "hono";
import { z } from "zod";

import {
  cancelOrganizationDeletion,
  deactivateOrganization,
  reactivateOrganization,
  scheduleOrganizationDeletion,
} from "@/services/organization-lifecycle.services";
import { withBody, withParam } from "@/utils/controller";
import { respond } from "@/utils/result";

const scheduleDeletionSchema = z.object({ confirmName: z.string().min(1, "Type the organization name to confirm") });

export const deactivateOrganizationController = (c: Context) =>
  withParam(c, "organizationId", async (id) =>
    respond(c, await deactivateOrganization(id, c.get("user").id), "Organization deactivated"),
  );

export const reactivateOrganizationController = (c: Context) =>
  withParam(c, "organizationId", async (id) =>
    respond(c, await reactivateOrganization(id, c.get("user").id), "Organization reactivated"),
  );

export const scheduleDeletionController = (c: Context) =>
  withParam(c, "organizationId", (id) =>
    withBody(c, scheduleDeletionSchema, async ({ confirmName }) =>
      respond(c, await scheduleOrganizationDeletion(id, c.get("user").id, confirmName), "Organization scheduled for deletion"),
    ),
  );

export const cancelDeletionController = (c: Context) =>
  withParam(c, "organizationId", async (id) =>
    respond(c, await cancelOrganizationDeletion(id, c.get("user").id), "Deletion cancelled"),
  );
