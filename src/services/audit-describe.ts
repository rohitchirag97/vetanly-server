import { eq, sql } from "drizzle-orm";

import db from "@/utils/db";
import {
  departmentsTable,
  employeeRecoverablesTable,
  holidaysTable,
  kioskDevicesTable,
  leaveRequestsTable,
  payrollRunsTable,
  shiftsTable,
  userOrganizationsTable,
  usersTable,
} from "@/drizzle/schema";

type Body = Record<string, unknown>;

export type AuditTargets = {
  employee?: string;
  record?: string;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const fullName = sql<string>`${usersTable.fname} || ' ' || ${usersTable.lname}`;

const userName = async (userId: string | undefined) => {
  if (!userId) return undefined;
  const [row] = await db
    .select({ name: fullName })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.name;
};

const nameByMembership = async (membershipId: string) => {
  const [row] = await db
    .select({ name: fullName })
    .from(userOrganizationsTable)
    .innerJoin(usersTable, eq(usersTable.id, userOrganizationsTable.userId))
    .where(eq(userOrganizationsTable.id, membershipId))
    .limit(1);
  return row?.name;
};

const isUuid = (value: string | undefined) =>
  !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const PARAM_BY_RESOURCE: Record<string, string> = {
  employee: "employeeId",
  "employee-record": "employeeId",
  leave: "requestId",
  regularization: "requestId",
  statutory: "employeeId",
  recoverable: "recoverableId",
  payroll: "runId",
  department: "departmentId",
  shift: "shiftId",
  holiday: "holidayId",
  "kiosk-device": "kioskId",
};

// Route params are not known to a catch-all middleware before the handler runs.
export const paramsFromPath = (path: string, apiPrefix: string): Record<string, string> => {
  const segments = path.replace(apiPrefix, "").split("/").filter(Boolean);
  const [resource, second, third] = segments;
  if (resource === "face-template" && second === "employee" && third) return { employeeId: third };
  const name = PARAM_BY_RESOURCE[resource];
  return name && second ? { [name]: second } : {};
};

// Must run before the handler: deleted records can no longer be looked up afterwards.
export const resolveTargets = async (
  params: Record<string, string>,
  body: Body,
): Promise<AuditTargets> => {
  const targets: AuditTargets = {};
  try {
    const employeeId = params.employeeId ?? str(body.employeeId);
    if (isUuid(employeeId)) targets.employee = await userName(employeeId);

    if (isUuid(params.requestId)) {
      const [row] = await db
        .select({ m: leaveRequestsTable.userOrganizationId })
        .from(leaveRequestsTable)
        .where(eq(leaveRequestsTable.id, params.requestId))
        .limit(1);
      if (row) targets.employee = await nameByMembership(row.m);
    } else if (isUuid(params.recoverableId)) {
      const [row] = await db
        .select({ m: employeeRecoverablesTable.userOrganizationId })
        .from(employeeRecoverablesTable)
        .where(eq(employeeRecoverablesTable.id, params.recoverableId))
        .limit(1);
      if (row) targets.employee = await nameByMembership(row.m);
    } else if (isUuid(params.runId)) {
      const [row] = await db
        .select({ s: payrollRunsTable.periodStart, e: payrollRunsTable.periodEnd })
        .from(payrollRunsTable)
        .where(eq(payrollRunsTable.id, params.runId))
        .limit(1);
      if (row) targets.record = `${row.s} to ${row.e}`;
    } else if (isUuid(params.departmentId)) {
      const [row] = await db
        .select({ n: departmentsTable.name })
        .from(departmentsTable)
        .where(eq(departmentsTable.id, params.departmentId))
        .limit(1);
      targets.record = row?.n;
    } else if (isUuid(params.shiftId)) {
      const [row] = await db
        .select({ n: shiftsTable.name })
        .from(shiftsTable)
        .where(eq(shiftsTable.id, params.shiftId))
        .limit(1);
      targets.record = row?.n;
    } else if (isUuid(params.holidayId)) {
      const [row] = await db
        .select({ n: holidaysTable.name })
        .from(holidaysTable)
        .where(eq(holidaysTable.id, params.holidayId))
        .limit(1);
      targets.record = row?.n;
    } else if (isUuid(params.kioskId)) {
      const [row] = await db
        .select({ n: kioskDevicesTable.name })
        .from(kioskDevicesTable)
        .where(eq(kioskDevicesTable.id, params.kioskId))
        .limit(1);
      targets.record = row?.n;
    }
  } catch {
    // A failed lookup must never block the request being audited.
  }
  return targets;
};

type Describe = (ctx: { body: Body; t: AuditTargets }) => {
  text: string;
  extra?: Record<string, unknown>;
};

const who = (t: AuditTargets) => t.employee ?? "an employee";
const rec = (t: AuditTargets) => (t.record ? `"${t.record}"` : "");

const describers: Record<string, Describe> = {
  "POST /employee": ({ body }) => ({
    text: `added employee ${[str(body.fname), str(body.lname)].filter(Boolean).join(" ")} as ${str(body.role) ?? "employee"}`,
  }),
  "PATCH /employee/:employeeId": ({ body, t }) => ({
    text: `updated the account of ${who(t)}`,
    extra: { role: str(body.role) },
  }),
  "PATCH /employee/:employeeId/status": ({ body, t }) =>
    body.isActive === false
      ? { text: `deactivated the access of ${who(t)}`, extra: { reason: str(body.reason) } }
      : { text: `reactivated the access of ${who(t)}` },
  "PATCH /employee/:employeeId/employment": ({ t }) => ({
    text: `updated the employment and pay details of ${who(t)}`,
  }),
  "DELETE /employee/:employeeId": ({ t }) => ({ text: `removed ${who(t)} from the organization` }),
  "PUT /employee-record/:employeeId/profile": ({ t }) => ({ text: `saved the profile of ${who(t)}` }),
  "POST /employee-record/:employeeId/documents": ({ t }) => ({ text: `uploaded a document for ${who(t)}` }),
  "DELETE /employee-record/:employeeId/documents/:documentId": ({ t }) => ({
    text: `deleted a document of ${who(t)}`,
  }),
  "POST /employee-record/:employeeId/tasks/start": ({ t }) => ({ text: `started the checklist for ${who(t)}` }),
  "POST /employee-record/:employeeId/tasks": ({ t }) => ({ text: `added a checklist task for ${who(t)}` }),
  "PATCH /employee-record/:employeeId/tasks/:taskId": ({ t }) => ({ text: `updated a checklist task of ${who(t)}` }),
  "DELETE /employee-record/:employeeId/tasks/:taskId": ({ t }) => ({ text: `deleted a checklist task of ${who(t)}` }),
  "PUT /employee-record/:employeeId/exit": ({ t }) => ({ text: `saved the exit details of ${who(t)}` }),
  "POST /employee-record/:employeeId/exit/complete": ({ t }) => ({ text: `completed the exit of ${who(t)}` }),
  "POST /employee-record/:employeeId/exit/cancel": ({ t }) => ({ text: `cancelled the exit of ${who(t)}` }),

  "POST /payroll/generate": ({ body }) => ({
    text: `generated payroll for ${str(body.periodStart) ?? "?"} to ${str(body.periodEnd) ?? "?"}`,
  }),
  "POST /payroll/:runId/finalize": ({ t }) => ({ text: `finalized the payroll run ${rec(t)}` }),
  "DELETE /payroll/:runId": ({ t }) => ({ text: `deleted the payroll run ${rec(t)}` }),
  "POST /payroll/slips/:itemId/whatsapp": () => ({ text: "sent a salary slip on WhatsApp" }),
  "PUT /payroll-settings": () => ({ text: "changed the payroll settings" }),

  "POST /leave": ({ body, t }) => ({
    text: `applied for leave ${str(body.startDate) ?? ""} to ${str(body.endDate) ?? ""} for ${who(t)}`,
  }),
  "PATCH /leave/:requestId/status": ({ body, t }) => ({
    text: `${str(body.status) ?? "updated"} the leave request of ${who(t)}`,
    extra: { note: str(body.reviewNote) },
  }),
  "POST /leave/types": ({ body }) => ({ text: `created leave type "${str(body.name) ?? ""}"` }),
  "PATCH /leave/types/:typeId": ({ body }) => ({
    text: `updated leave type${str(body.name) ? ` "${str(body.name)}"` : ""}`,
  }),

  "POST /regularization": ({ body }) => ({
    text: `requested an attendance correction for ${str(body.date) ?? ""}`,
    extra: { note: str(body.reason) },
  }),
  "PATCH /regularization/:requestId/status": ({ body }) => ({
    text: `${str(body.status) ?? "updated"} an attendance correction`,
    extra: { note: str(body.reviewNote) },
  }),

  "PUT /statutory/settings": () => ({ text: "updated the statutory compliance settings (PF, ESI, PT, TDS)" }),
  "POST /announcements": ({ body }) => ({ text: `published announcement "${str(body.title) ?? ""}"` }),
  "DELETE /announcements/:announcementId": () => ({ text: "deleted an announcement" }),
  "POST /overtime/review": ({ body }) => {
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const status = str((entries[0] as Record<string, unknown> | undefined)?.status) ?? "reviewed";
    return { text: `${status} overtime for ${entries.length} day${entries.length === 1 ? "" : "s"}` };
  },
  "PUT /statutory/employees/:employeeId": ({ t }) => ({
    text: `updated the statutory details of ${who(t)}`,
  }),

  "POST /recoverable": ({ body, t }) => ({
    text: `created a ${str(body.type) === "salary_advance" ? "salary advance" : "loan"} for ${who(t)}`,
  }),
  "PATCH /recoverable/:recoverableId/status": ({ body, t }) => ({
    text: `${str(body.status) ?? "updated"} the loan/advance of ${who(t)}`,
  }),
  "POST /recoverable/:recoverableId/repayments": ({ t }) => ({ text: `recorded a repayment for ${who(t)}` }),
  "POST /recoverable/:recoverableId/noc/whatsapp": ({ t }) => ({
    text: `sent the loan NOC of ${who(t)} on WhatsApp`,
  }),

  "POST /expenses": () => ({ text: "submitted an expense claim" }),
  "POST /expenses/:claimId/cancel": () => ({ text: "cancelled their expense claim" }),
  "PATCH /expenses/:claimId/review": ({ body }) => ({
    text: `${str(body.status) ?? "reviewed"} an expense claim`,
    extra: { reason: str(body.note) },
  }),
  "POST /expenses/:claimId/paid": () => ({ text: "marked an expense claim as paid outside payroll" }),

  "PUT /tax-declarations/mine": ({ body }) => ({
    text: `saved their tax declaration (${str(body.taxRegime) === "old" ? "old" : "new"} regime, FY ${str(body.financialYear) ?? ""})`,
  }),
  "POST /tax-declarations/mine/items": ({ body }) => ({ text: `declared a ${str(body.section) ?? ""} tax-saving item` }),
  "PATCH /tax-declarations/items/:itemId": () => ({ text: "changed a tax declaration item" }),
  "DELETE /tax-declarations/items/:itemId": () => ({ text: "removed a tax declaration item" }),
  "POST /tax-declarations/items/:itemId/proof": () => ({ text: "uploaded a tax declaration proof" }),
  "PATCH /tax-declarations/items/:itemId/review": ({ body }) => ({
    text: `${str(body.status) ?? "reviewed"} a tax declaration item`,
    extra: { reason: str(body.note) },
  }),
  "PUT /tax-declarations/settings": ({ body }) => ({
    text: `set the tax declaration deadlines for FY ${str(body.financialYear) ?? ""}`,
  }),

  "POST /roster/rotations": ({ body }) => ({ text: `created shift rotation "${str(body.name) ?? ""}"` }),
  "PUT /roster/rotations/:rotationId": ({ body }) => ({ text: `updated shift rotation "${str(body.name) ?? ""}"` }),
  "DELETE /roster/rotations/:rotationId": () => ({ text: "deleted a shift rotation" }),
  "POST /roster/assign": ({ body }) => ({
    text: `put ${Array.isArray(body.employeeIds) ? body.employeeIds.length : 0} employee(s) on a shift rotation from ${str(body.startsOn) ?? ""}`,
  }),
  "POST /roster/end": ({ body }) => ({ text: `took employee(s) off their shift rotation from ${str(body.fromDate) ?? ""}` }),
  "PUT /roster/override": ({ body }) => ({
    text: body.clear ? `cleared a roster change on ${str(body.date) ?? ""}` : `changed a roster shift on ${str(body.date) ?? ""}`,
  }),
  "POST /roster/swaps": ({ body }) => ({ text: `asked a colleague to swap shifts on ${str(body.date) ?? ""}` }),
  "PATCH /roster/swaps/:swapId/respond": ({ body }) => ({ text: `${body.accept ? "accepted" : "declined"} a shift swap request` }),
  "POST /roster/swaps/:swapId/cancel": () => ({ text: "cancelled their shift swap request" }),
  "PATCH /roster/swaps/:swapId/review": ({ body }) => ({
    text: `${body.approve ? "approved" : "rejected"} a shift swap`,
    extra: { reason: str(body.note) },
  }),

  "POST /attendance/manual": ({ t }) => ({ text: `marked attendance manually for ${who(t)}` }),
  "DELETE /face-template/employee/:employeeId": ({ t }) => ({ text: `revoked the face data of ${who(t)}` }),

  "POST /holiday": ({ body }) => ({ text: `added holiday "${str(body.name) ?? ""}" on ${str(body.date) ?? ""}` }),
  "PATCH /holiday/:holidayId": ({ t }) => ({ text: `updated holiday ${rec(t)}` }),
  "DELETE /holiday/:holidayId": ({ t }) => ({ text: `deleted holiday ${rec(t)}` }),
  "POST /department": ({ body }) => ({ text: `created department "${str(body.name) ?? ""}"` }),
  "PATCH /department/:departmentId": ({ t }) => ({ text: `updated department ${rec(t)}` }),
  "DELETE /department/:departmentId": ({ t }) => ({ text: `deleted department ${rec(t)}` }),
  "POST /shift": ({ body }) => ({ text: `created shift "${str(body.name) ?? ""}"` }),
  "PATCH /shift/:shiftId": ({ t }) => ({ text: `updated shift ${rec(t)}` }),
  "DELETE /shift/:shiftId": ({ t }) => ({ text: `deleted shift ${rec(t)}` }),
  "POST /kiosk-device": ({ body }) => ({ text: `registered kiosk "${str(body.name) ?? ""}"` }),
  "PATCH /kiosk-device/:kioskId": ({ t }) => ({ text: `updated kiosk ${rec(t)}` }),
  "POST /kiosk-device/:kioskId/rotate-key": ({ t }) => ({ text: `rotated the key of kiosk ${rec(t)}` }),
  "PATCH /organization/:organizationId": () => ({ text: "updated the organization details" }),
};

export const describeAction = (input: {
  actor: string;
  method: string;
  routePath: string;
  apiPrefix: string;
  body: Body;
  targets: AuditTargets;
  statusCode: number;
  message: string | undefined;
}) => {
  const { actor, method, body, targets, statusCode, message } = input;
  const shortPath = input.routePath.startsWith(input.apiPrefix)
    ? input.routePath.slice(input.apiPrefix.length)
    : input.routePath;
  const described = describers[`${method} ${shortPath}`]?.({ body, t: targets });
  const text = (described?.text ?? `made a ${method} request to ${shortPath}`).replace(/\s+/g, " ").trim();
  const success = statusCode < 400;
  const reason = str(described?.extra?.reason);
  const summary =
    `${actor} ${text}` +
    (reason ? ` — reason: ${reason}` : "") +
    (success ? "" : ` — FAILED${message ? `: ${message}` : ""}`);
  return {
    summary: summary.slice(0, 1000),
    details: {
      outcome: success ? "success" : "failed",
      message: message ?? null,
      target: targets.employee ?? targets.record ?? null,
      ...Object.fromEntries(Object.entries(described?.extra ?? {}).filter(([, v]) => v !== undefined)),
    } as Record<string, unknown>,
  };
};
