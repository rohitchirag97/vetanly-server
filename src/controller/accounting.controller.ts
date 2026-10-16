import { exportJournal, getAccountingSettings, previewJournal, saveAccountingSettings } from "@/services/accounting.services";
import { withBody, withOrganization, withQuery } from "@/utils/controller";
import { respond } from "@/utils/result";
import { accountingExportSchema, accountingRangeSchema, accountingSettingsSchema } from "@/validator/accounting.validator";

export const accountingSettingsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await getAccountingSettings(organizationId, userId), "Accounting settings fetched"),
);

export const saveAccountingSettingsController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, accountingSettingsSchema, async (body) => respond(c, await saveAccountingSettings(organizationId, userId, body), "Accounting settings saved")),
);

export const previewJournalController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, accountingRangeSchema, async (query) => respond(c, await previewJournal(organizationId, userId, query), "Journal fetched")),
);

export const exportJournalController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, accountingExportSchema, async (body) => {
    const result = await exportJournal(organizationId, userId, body);
    if (!result.ok) return respond(c, result, "");
    return new Response(new Uint8Array(result.data.body), {
      headers: {
        "Content-Type": result.data.contentType,
        "Content-Disposition": `attachment; filename="${result.data.fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }),
);
