import {
  acknowledgeAsset,
  assetHistory,
  assignableEmployees,
  assignAsset,
  createAsset,
  deleteAsset,
  employeeAssets,
  listAssets,
  myAssets,
  returnAsset,
  setAssetStatus,
  updateAsset,
} from "@/services/asset.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import { assetSchema, assetStatusSchema, assignAssetSchema, listAssetsQuerySchema, returnAssetSchema } from "@/validator/asset.validator";

export const listAssetsController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listAssetsQuerySchema, async (query) => respond(c, await listAssets(organizationId, userId, query), "Assets fetched")),
);

export const createAssetController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, assetSchema, async (body) => respond(c, await createAsset(organizationId, userId, body), "Asset added", 201)),
);

export const updateAssetController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "assetId", (id) => withBody(c, assetSchema, async (body) => respond(c, await updateAsset(organizationId, userId, id, body), "Asset updated"))),
);

export const deleteAssetController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "assetId", async (id) => respond(c, await deleteAsset(organizationId, userId, id), "Asset deleted")),
);

export const assetHistoryController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "assetId", async (id) => respond(c, await assetHistory(organizationId, userId, id), "Asset history fetched")),
);

export const assignAssetController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "assetId", (id) => withBody(c, assignAssetSchema, async (body) => respond(c, await assignAsset(organizationId, userId, id, body), "Asset assigned"))),
);

export const returnAssetController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "assetId", (id) =>
    withBody(c, returnAssetSchema, async (body) => respond(c, await returnAsset(organizationId, userId, id, body), body.lost ? "Asset recorded as lost" : "Asset returned")),
  ),
);

export const assetStatusController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "assetId", (id) => withBody(c, assetStatusSchema, async (body) => respond(c, await setAssetStatus(organizationId, userId, id, body), "Asset status updated"))),
);

export const myAssetsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await myAssets(organizationId, userId), "Your assets fetched"),
);

export const acknowledgeAssetController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "assignmentId", async (id) => respond(c, await acknowledgeAsset(organizationId, userId, id), "Receipt confirmed")),
);

export const employeeAssetsController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (id) => respond(c, await employeeAssets(organizationId, userId, id), "Employee assets fetched")),
);

export const assignableEmployeesController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await assignableEmployees(organizationId, userId), "Employees fetched"),
);
