import {
  checkBulkEmployees,
  createEmployeeForOrganization,
  listEmployeesForOrganization,
  removeEmployeeFromOrganization,
  setEmployeeMembershipActive,
  updateEmployeeForOrganization,
} from "@/services/user.services";
import { sendResponse } from "@/utils/response";
import { withBody } from "@/utils/controller";
import { respond } from "@/utils/result";
import { requireFullAccess } from "@/services/billing-access.services";
import {
  createEmployeeSchema,
  bulkCheckEmployeesSchema,
  bulkCreateEmployeesSchema,
  removeEmployeeSchema,
  updateEmployeeSchema,
  updateEmployeeStatusSchema,
} from "@/validator/employee.validator";
import type { Context } from "hono";

export const listEmployeesController = async (c: Context): Promise<Response> => {
  const user = c.get("user");
  if (!user) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }

  const organizationId = c.req.query("organizationId");
  if (!organizationId) {
    return sendResponse(c, "error", "Organization is required", null, 400);
  }

  const result = await listEmployeesForOrganization(organizationId, user.id, c.req.query("all") === "true");
  if (result.status === "organization-not-found") {
    return sendResponse(c, "error", "Organization not found", null, 404);
  }
  if (result.status === "forbidden") {
    return sendResponse(c, "error", "Forbidden", null, 403);
  }

  return sendResponse(
    c,
    "success",
    "Employees fetched successfully",
    result.employees,
  );
};

export const updateEmployeeController = async (c: Context): Promise<Response> => {
  const user = c.get("user");
  if (!user) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = updateEmployeeSchema.safeParse(body);
  if (!parsed.success) {
    return sendResponse(
      c,
      "error",
      parsed.error.issues[0]?.message ?? "Invalid employee details",
      null,
      400,
    );
  }

  const employeeId = c.req.param("employeeId");
  if (!employeeId) {
    return sendResponse(c, "error", "Employee ID is required", null, 400);
  }

  const result = await updateEmployeeForOrganization(
    employeeId,
    parsed.data,
    user.id,
  );

  if (result.status === "organization-not-found") {
    return sendResponse(c, "error", "Organization not found", null, 404);
  }
  if (result.status === "forbidden") {
    return sendResponse(c, "error", "Forbidden", null, 403);
  }
  if (result.status === "employee-not-found") {
    return sendResponse(c, "error", "Employee not found in this organization", null, 404);
  }
  if (result.status === "cannot-update-super-admin") {
    return sendResponse(c, "error", "Super admin role cannot be updated", null, 403);
  }

  return sendResponse(
    c,
    "success",
    "Employee updated successfully",
    { employee: result.employee },
  );
};

const respondToMembershipAction = (
  c: Context,
  result: { status: string },
): Response | null => {
  if (result.status === "organization-not-found") {
    return sendResponse(c, "error", "Organization not found", null, 404);
  }
  if (result.status === "forbidden") {
    return sendResponse(c, "error", "Forbidden", null, 403);
  }
  if (result.status === "employee-not-found") {
    return sendResponse(c, "error", "Employee not found in this organization", null, 404);
  }
  if (result.status === "holds-assets") {
    return sendResponse(
      c,
      "error",
      `This person still holds ${"count" in result ? result.count : "some"} company asset(s). Take them back on the Assets page first, or deactivate them instead.`,
      null,
      409,
    );
  }
  if (result.status === "has-history") {
    return sendResponse(
      c,
      "error",
      "This person has attendance, leave or payroll records in this organization, so they can't be removed. Deactivate them instead.",
      null,
      409,
    );
  }
  if (result.status === "cannot-remove-super-admin") {
    return sendResponse(
      c,
      "error",
      "The organization owner cannot leave or be removed",
      null,
      403,
    );
  }
  if (result.status === "cannot-manage-super-admin") {
    return sendResponse(c, "error", "Super admin membership cannot be changed", null, 403);
  }
  if (result.status === "forbidden") {
    return sendResponse(c, "error", "Only an organization admin can remove another member", null, 403);
  }
  return null;
};

export const updateEmployeeStatusController = async (
  c: Context,
): Promise<Response> => {
  const user = c.get("user");
  if (!user) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = updateEmployeeStatusSchema.safeParse(body);
  if (!parsed.success) {
    return sendResponse(
      c,
      "error",
      parsed.error.issues[0]?.message ?? "Invalid employee status",
      null,
      400,
    );
  }

  const employeeId = c.req.param("employeeId");
  if (!employeeId) {
    return sendResponse(c, "error", "Employee ID is required", null, 400);
  }

  if (parsed.data.isActive) {
    const billing = await requireFullAccess(parsed.data.organizationId);
    if (!billing.ok) return respond(c, billing, "");
  }

  const result = await setEmployeeMembershipActive(
    employeeId,
    parsed.data.organizationId,
    parsed.data.isActive,
    user.id,
    parsed.data.reason,
  );
  const errorResponse = respondToMembershipAction(c, result);
  if (errorResponse) return errorResponse;

  return sendResponse(
    c,
    "success",
    parsed.data.isActive ? "Employee reactivated" : "Employee deactivated",
    { isActive: parsed.data.isActive },
  );
};

export const removeEmployeeController = async (c: Context): Promise<Response> => {
  const user = c.get("user");
  if (!user) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = removeEmployeeSchema.safeParse(body);
  if (!parsed.success) {
    return sendResponse(
      c,
      "error",
      parsed.error.issues[0]?.message ?? "Invalid organization",
      null,
      400,
    );
  }

  const employeeId = c.req.param("employeeId");
  if (!employeeId) {
    return sendResponse(c, "error", "Employee ID is required", null, 400);
  }

  const result = await removeEmployeeFromOrganization(
    employeeId,
    parsed.data.organizationId,
    user.id,
  );
  const errorResponse = respondToMembershipAction(c, result);
  if (errorResponse) return errorResponse;

  return sendResponse(c, "success", "Employee removed from organization");
};

/** Previews a bulk upload: which rows would be new, already in the organization, or blocked. Writes nothing. */
export const bulkCheckEmployeesController = (c: Context): Promise<Response> =>
  withBody(c, bulkCheckEmployeesSchema, async ({ organizationId, phones, employeeCodes }) =>
    respond(
      c,
      await checkBulkEmployees(organizationId, c.get("user").id, phones, employeeCodes),
      "Employees checked",
    ),
  );

export const bulkCreateEmployeesController = async (c: Context): Promise<Response> => {
  const user = c.get("user");
  if (!user) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = bulkCreateEmployeesSchema.safeParse(body);
  if (!parsed.success) {
    return sendResponse(
      c,
      "error",
      parsed.error.issues[0]?.message ?? "Invalid employee list",
      null,
      400,
    );
  }

  const { organizationId, employees, branchId } = parsed.data;
  const billing = await requireFullAccess(organizationId);
  if (!billing.ok) return respond(c, billing, "");
  const seenPhones = new Set<string>();
  const results: { row: number; phone: string; status: string; employeeId?: string }[] = [];

  for (const [index, employee] of employees.entries()) {
    const row = index + 1;
    if (seenPhones.has(employee.phone)) {
      results.push({ row, phone: employee.phone, status: "duplicate-in-file" });
      continue;
    }
    seenPhones.add(employee.phone);
    try {
      const result = await createEmployeeForOrganization({ ...employee, organizationId, branchId }, user.id);
      if (result.status === "organization-not-found") {
        return sendResponse(c, "error", "Organization not found", null, 404);
      }
      if (result.status === "forbidden" && index === 0) {
        return sendResponse(c, "error", "Forbidden", null, 403);
      }
      results.push({
        row,
        phone: employee.phone,
        status: result.status,
        employeeId: "employee" in result ? result.employee.id : undefined,
      });
    } catch (error) {
      console.error("Bulk employee row failed:", error);
      results.push({ row, phone: employee.phone, status: "failed" });
    }
  }

  const created = results.filter((r) => r.status === "created" || r.status === "added").length;
  return sendResponse(c, "success", `${created} of ${employees.length} employees added`, { results }, 200);
};

export const createEmployeeController = async (c: Context): Promise<Response> => {
  const user = c.get("user");
  if (!user) {
    return sendResponse(c, "error", "Unauthorized", null, 401);
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = createEmployeeSchema.safeParse(body);
  if (!parsed.success) {
    return sendResponse(
      c,
      "error",
      parsed.error.issues[0]?.message ?? "Invalid employee details",
      null,
      400,
    );
  }

  const billing = await requireFullAccess(parsed.data.organizationId);
  if (!billing.ok) return respond(c, billing, "");

  const result = await createEmployeeForOrganization(
    parsed.data,
    user.id,
  );

  if (result.status === "organization-not-found") {
    return sendResponse(c, "error", "Organization not found", null, 404);
  }
  if (result.status === "forbidden") {
    return sendResponse(c, "error", "Forbidden", null, 403);
  }
  if (result.status === "already-member") {
    return sendResponse(
      c,
      "success",
      "Employee is already in this organization; details updated",
      { employee: result.employee },
      200,
    );
  }
  if (result.status === "added") {
    return sendResponse(
      c,
      "success",
      "Existing user added to organization",
      { employee: result.employee },
      200,
    );
  }

  return sendResponse(
    c,
    "success",
    "Employee created successfully",
    { employee: result.employee },
    201,
  );
};
