import { MANAGER_ROLES, requireRole } from "@/services/access.services";
import { buildReport } from "@/services/report.services";
import { buildPfEcr } from "@/services/statutory-report.services";
import { fail, respond } from "@/utils/result";
import { buildPdf, buildXlsx } from "@/services/report-render";
import { withOrganization, withQuery } from "@/utils/controller";
import { reportQuerySchema } from "@/validator/report.validator";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const downloadReportController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, reportQuerySchema, async (query) => {
    if (query.format === "ecr") {
      if (!query.runId) return respond(c, fail("invalid", "Choose a payroll run"), "");
      const access = await requireRole(organizationId, userId, MANAGER_ROLES);
      if (!access.ok) return respond(c, access, "");
      const ecr = await buildPfEcr(organizationId, userId, query.runId);
      if (!ecr.ok) return respond(c, ecr, "");
      return new Response(ecr.data.text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${ecr.data.fileName}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const report = await buildReport(organizationId, userId, query);
    if (!report.ok) return respond(c, report, "");

    const body = query.format === "xlsx" ? await buildXlsx(report.data) : await buildPdf(report.data);
    const fileName = `${report.data.fileName}.${query.format}`.replace(/[^\w.-]/g, "_");
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": query.format === "xlsx" ? XLSX : "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  }),
);
