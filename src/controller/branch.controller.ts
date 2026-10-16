import { createBranch, listBranches, setBranchActive, setBranchManagers, updateBranch } from "@/services/branch.services";
import { withBody, withOrganization, withParam } from "@/utils/controller";
import { respond } from "@/utils/result";
import { branchManagersSchema, branchSchema, branchStatusSchema } from "@/validator/branch.validator";

export const listBranchesController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listBranches(organizationId, userId), "Branches fetched"),
);

export const createBranchController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, branchSchema, async (body) => respond(c, await createBranch(organizationId, userId, body), "Branch created", 201)),
);

export const updateBranchController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "branchId", (id) =>
    withBody(c, branchSchema, async (body) => respond(c, await updateBranch(organizationId, userId, id, body), "Branch updated")),
  ),
);

export const branchStatusController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "branchId", (id) =>
    withBody(c, branchStatusSchema, async (body) =>
      respond(c, await setBranchActive(organizationId, userId, id, body.isActive), body.isActive ? "Branch reopened" : "Branch closed"),
    ),
  ),
);

export const branchManagersController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "branchId", (id) =>
    withBody(c, branchManagersSchema, async (body) => respond(c, await setBranchManagers(organizationId, userId, id, body), "Branch managers saved")),
  ),
);
