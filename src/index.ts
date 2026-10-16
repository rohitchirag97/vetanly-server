import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

import { env } from "@/utils/env";
import authRoutes from "@/routes/auth.routes";
import userRoutes from "@/routes/user.routes";
import organizationRoutes from "@/routes/organization.route";
import employeeRoutes from "@/routes/employee.route";
import departmentRoutes from "@/routes/department.route";
import shiftRoutes from "@/routes/shift.route";
import holidayRoutes from "@/routes/holiday.route";
import employeeRecordRoutes from "@/routes/employee-record.route";
import payrollSettingsRoutes from "@/routes/payroll-settings.route";
import payrollRoutes from "@/routes/payroll.route";
import kioskRoutes from "@/routes/kiosk-device.route";
import leaveRoutes from "@/routes/leave.route";
import faceTemplateRoutes from "@/routes/face-template.route";
import attendanceRoutes from "@/routes/attendance.route";
import recoverableRoutes from "@/routes/recoverable.route";
import auditRoutes from "@/routes/audit.route";
import notificationRoutes from "@/routes/notification.route";
import reportRoutes from "@/routes/report.route";
import regularizationRoutes from "@/routes/regularization.route";
import statutoryRoutes from "@/routes/statutory.route";
import overtimeRoutes from "@/routes/overtime.route";
import announcementRoutes from "@/routes/announcement.route";
import platformRoutes from "@/routes/platform.route";
import billingRoutes from "@/routes/billing.route";
import onboardingRoutes from "@/routes/onboarding.route";
import expenseRoutes from "@/routes/expense.route";
import fileRoutes from "@/routes/file.route";
import taxDeclarationRoutes from "@/routes/tax-declaration.route";
import rosterRoutes from "@/routes/roster.route";
import settlementRoutes from "@/routes/settlement.route";
import bonusRoutes from "@/routes/bonus.route";
import branchRoutes from "@/routes/branch.route";
import accountingRoutes from "@/routes/accounting.route";
import assetRoutes from "@/routes/asset.route";
import insightsRoutes from "@/routes/insights.route";
import messagingRoutes from "@/routes/messaging.route";
import webhookRoutes from "@/routes/webhook.route";
import { auditMiddleware } from "@/middleware/audit.middleware";
import { ensureAuditLogGuards } from "@/services/audit.services";
import { pruneNotifications } from "@/services/notification.services";
import { purgeDueOrganizations } from "@/services/organization-lifecycle.services";
import { registerShutdownHandlers } from "@/lifecycle/shutdown";

const app: Hono = new Hono({ strict: false });
app.use(secureHeaders({ crossOriginResourcePolicy: "cross-origin" }));
// Tokens travel in the Authorization header, so CORS is not a credential channel; still restrict it when configured.
const corsOrigins = env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors(corsOrigins?.length ? { origin: corsOrigins } : undefined));

const $apiPrefix: string = "/api/v1";

app.use(`${$apiPrefix}/*`, auditMiddleware);

app.route(`${$apiPrefix}/auth`, authRoutes);
app.route(`${$apiPrefix}/user`, userRoutes);
app.route(`${$apiPrefix}/organization`, organizationRoutes);
app.route(`${$apiPrefix}/employee`, employeeRoutes);
app.route(`${$apiPrefix}/department`, departmentRoutes);
app.route(`${$apiPrefix}/shift`, shiftRoutes);
app.route(`${$apiPrefix}/holiday`, holidayRoutes);
app.route(`${$apiPrefix}/employee-record`, employeeRecordRoutes);
app.route(`${$apiPrefix}/payroll-settings`, payrollSettingsRoutes);
app.route(`${$apiPrefix}/payroll`, payrollRoutes);
app.route(`${$apiPrefix}/kiosk-device`, kioskRoutes);
app.route(`${$apiPrefix}/leave`, leaveRoutes);
app.route(`${$apiPrefix}/face-template`, faceTemplateRoutes);
app.route(`${$apiPrefix}/attendance`, attendanceRoutes);
app.route(`${$apiPrefix}/recoverable`, recoverableRoutes);
app.route(`${$apiPrefix}/audit-log`, auditRoutes);
app.route(`${$apiPrefix}/notification`, notificationRoutes);
app.route(`${$apiPrefix}/report`, reportRoutes);
app.route(`${$apiPrefix}/regularization`, regularizationRoutes);
app.route(`${$apiPrefix}/statutory`, statutoryRoutes);
app.route(`${$apiPrefix}/overtime`, overtimeRoutes);
app.route(`${$apiPrefix}/announcements`, announcementRoutes);
app.route(`${$apiPrefix}/platform`, platformRoutes);
app.route(`${$apiPrefix}/billing`, billingRoutes);
app.route(`${$apiPrefix}/onboarding`, onboardingRoutes);
app.route(`${$apiPrefix}/expenses`, expenseRoutes);
app.route(`${$apiPrefix}/files`, fileRoutes);
app.route(`${$apiPrefix}/tax-declarations`, taxDeclarationRoutes);
app.route(`${$apiPrefix}/roster`, rosterRoutes);
app.route(`${$apiPrefix}/settlements`, settlementRoutes);
app.route(`${$apiPrefix}/bonus`, bonusRoutes);
app.route(`${$apiPrefix}/branches`, branchRoutes);
app.route(`${$apiPrefix}/accounting`, accountingRoutes);
app.route(`${$apiPrefix}/assets`, assetRoutes);
app.route(`${$apiPrefix}/insights`, insightsRoutes);
app.route(`${$apiPrefix}/messaging`, messagingRoutes);
// Provider callbacks: outside the API prefix, so no login or audit logging applies.
app.route("/webhooks", webhookRoutes);

await ensureAuditLogGuards();
void pruneNotifications();
setInterval(() => void pruneNotifications().catch(() => {}), 24 * 60 * 60 * 1000).unref();
// Erases organizations whose 30-day deletion window has passed.
void purgeDueOrganizations().catch((error) => console.error("Organization purge failed", error));
setInterval(() => void purgeDueOrganizations().catch((error) => console.error("Organization purge failed", error)), 60 * 60 * 1000).unref();

const server = Bun.serve({
  port: Number(env.PORT),
  fetch: (request, bunServer) => app.fetch(request, bunServer),
});

console.info(`API listening on port ${server.port}`);

registerShutdownHandlers(server);
