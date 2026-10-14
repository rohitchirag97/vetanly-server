import { Hono } from "hono";

import { authenticate } from "@/middleware/authenticate.middleware";
import {
	createOrganization,
	getOrganizationBySlugController,
	getUsersOrganizationsController,
	updateOrganizationController,
} from "@/controller/organization.controller";
import {
	cancelDeletionController,
	deactivateOrganizationController,
	reactivateOrganizationController,
	scheduleDeletionController,
} from "@/controller/organization-lifecycle.controller";

const organizationRoutes: Hono = new Hono();

organizationRoutes.post("/", authenticate, createOrganization);
organizationRoutes.get("/", authenticate, getUsersOrganizationsController);
organizationRoutes.patch("/:organizationId", authenticate, updateOrganizationController);
organizationRoutes.post("/:organizationId/deactivate", authenticate, deactivateOrganizationController);
organizationRoutes.post("/:organizationId/reactivate", authenticate, reactivateOrganizationController);
organizationRoutes.post("/:organizationId/deletion", authenticate, scheduleDeletionController);
organizationRoutes.delete("/:organizationId/deletion", authenticate, cancelDeletionController);
organizationRoutes.get("/:organizationSlug", authenticate, getOrganizationBySlugController);

export default organizationRoutes;
