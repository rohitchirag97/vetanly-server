import type { Context } from "hono";

import { buildForm12bbPdf } from "@/services/form12bb-pdf";
import {
  addDeclarationItem,
  currentFinancialYear,
  deleteDeclarationItem,
  getDeclarationForReview,
  getDeclarationSettings,
  getMyDeclaration,
  getProofUrl,
  listDeclarations,
  loadForm12bb,
  reviewDeclarationItem,
  saveDeclarationSettings,
  saveMyDeclaration,
  updateDeclarationItem,
  uploadItemProof,
} from "@/services/tax-declaration.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { decryptSecret } from "@/utils/crypto";
import { badRequest } from "@/utils/request";
import { respond } from "@/utils/result";
import {
  declarationItemSchema,
  financialYearQuerySchema,
  reviewDeclarationItemSchema,
  saveDeclarationSchema,
  taxDeclarationSettingsSchema,
} from "@/validator/tax-declaration.validator";

/** The financial year from the query string, or the current one. */
const withYear = (c: Context, handler: (financialYear: string) => Promise<Response>) =>
  withQuery(c, financialYearQuerySchema.partial(), (query) => handler(query.financialYear ?? currentFinancialYear()));

export const myDeclarationController = withOrganization((c, { organizationId, userId }) =>
  withYear(c, async (fy) => respond(c, await getMyDeclaration(organizationId, userId, fy), "Declaration fetched")),
);

export const saveMyDeclarationController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, saveDeclarationSchema, async (body) =>
    respond(c, await saveMyDeclaration(organizationId, userId, body), "Declaration saved"),
  ),
);

export const addItemController = withOrganization((c, { organizationId, userId }) =>
  withYear(c, (fy) =>
    withBody(c, declarationItemSchema, async (body) =>
      respond(c, await addDeclarationItem(organizationId, userId, fy, body), "Item added", 201),
    ),
  ),
);

export const updateItemController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "itemId", (id) =>
    withBody(c, declarationItemSchema, async (body) =>
      respond(c, await updateDeclarationItem(organizationId, userId, id, body), "Item updated"),
    ),
  ),
);

export const deleteItemController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "itemId", async (id) => respond(c, await deleteDeclarationItem(organizationId, userId, id), "Item removed")),
);

export const uploadProofController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "itemId", async (id) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.proof;
    if (!(file instanceof File)) return badRequest(c, "Attach the proof file");
    return respond(c, await uploadItemProof(organizationId, userId, id, file), "Proof uploaded");
  }),
);

export const proofUrlController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "itemId", async (id) => respond(c, await getProofUrl(organizationId, userId, id), "Proof link created")),
);

export const listDeclarationsController = withOrganization((c, { organizationId, userId }) =>
  withYear(c, async (fy) => respond(c, await listDeclarations(organizationId, userId, fy), "Declarations fetched")),
);

export const getSettingsController = withOrganization((c, { organizationId, userId }) =>
  withYear(c, async (fy) => respond(c, await getDeclarationSettings(organizationId, userId, fy), "Settings fetched")),
);

export const saveSettingsController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, taxDeclarationSettingsSchema, async (body) =>
    respond(c, await saveDeclarationSettings(organizationId, userId, body), "Settings saved"),
  ),
);

export const reviewDetailController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "declarationId", async (id) =>
    respond(c, await getDeclarationForReview(organizationId, userId, id), "Declaration fetched"),
  ),
);

export const reviewItemController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "itemId", (id) =>
    withBody(c, reviewDeclarationItemSchema, async (body) =>
      respond(c, await reviewDeclarationItem(organizationId, userId, id, body), `Item ${body.status}`),
    ),
  ),
);

export const form12bbController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "declarationId", async (id) => {
    const loaded = await loadForm12bb(organizationId, userId, id);
    if (!loaded.ok) return respond(c, loaded, "");
    let pan: string | null = null;
    try {
      pan = loaded.data.panStored ? decryptSecret(loaded.data.panStored) : null;
    } catch {
      pan = null;
    }
    const pdf = await buildForm12bbPdf({ ...loaded.data, pan });
    const name = `Form-12BB_${loaded.data.employeeName.replace(/[^\w]+/g, "-")}_${loaded.data.view.financialYear}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }),
);
