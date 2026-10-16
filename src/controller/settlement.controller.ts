import { buildSettlementPdf } from "@/services/settlement-pdf";
import {
  cancelSettlementDraft,
  finalizeSettlement,
  getSettlement,
  listSettlements,
  loadSettlementStatement,
  markSettlementPaid,
  saveSettlementDraft,
} from "@/services/settlement.services";
import { withBody, withOrganization, withParam } from "@/utils/controller";
import { respond } from "@/utils/result";
import { markSettlementPaidSchema, settlementInputsSchema } from "@/validator/settlement.validator";

export const listSettlementsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listSettlements(organizationId, userId), "Settlements fetched"),
);

export const getSettlementController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (id) => respond(c, await getSettlement(organizationId, userId, id), "Settlement fetched")),
);

export const saveDraftController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (id) =>
    withBody(c, settlementInputsSchema, async (body) => respond(c, await saveSettlementDraft(organizationId, userId, id, body), "Draft saved")),
  ),
);

export const finalizeController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (id) => respond(c, await finalizeSettlement(organizationId, userId, id), "Settlement finalized")),
);

export const markPaidController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (id) =>
    withBody(c, markSettlementPaidSchema, async (body) => respond(c, await markSettlementPaid(organizationId, userId, id, body), "Settlement marked paid")),
  ),
);

export const cancelDraftController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (id) => respond(c, await cancelSettlementDraft(organizationId, userId, id), "Draft discarded")),
);

export const statementController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (id) => {
    const loaded = await loadSettlementStatement(organizationId, userId, id);
    if (!loaded.ok) return respond(c, loaded, "");
    const pdf = await buildSettlementPdf(loaded.data);
    const name = `Full-and-Final_${loaded.data.employee.employeeName.replace(/[^\w]+/g, "-")}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" },
    });
  }),
);
