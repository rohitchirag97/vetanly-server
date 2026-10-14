import { Hono } from "hono";

import { authenticate } from "@/middleware/authenticate.middleware";
import {
	createOrganization,
	getOrganizationBySlugController,
	getUsersOrganizationsController,
	updateOrganizationController,
} from "@/controller/organization.controller";

const organizationRoutes: Hono = new Hono();

organizationRoutes.post("/", authenticate, createOrganization);
organizationRoutes.get("/", authenticate, getUsersOrganizationsController);
organizationRoutes.patch("/:organizationId", authenticate, updateOrganizationController);
organizationRoutes.get("/:organizationSlug", authenticate, getOrganizationBySlugController);

export default organizationRoutes;
