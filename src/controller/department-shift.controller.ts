import {
  createDepartment,
  createShift,
  deleteDepartment,
  deleteShift,
  listDepartments,
  listShifts,
  updateDepartment,
  updateShift,
} from "@/services/department-shift.services";
import { withBody, withOrganization, withParam } from "@/utils/controller";
import { respond } from "@/utils/result";
import {
  createDepartmentSchema,
  createShiftSchema,
  updateDepartmentSchema,
  updateShiftSchema,
} from "@/validator/department-shift.validator";

export const listDepartmentsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listDepartments(organizationId, userId), "Departments fetched"),
);

export const createDepartmentController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createDepartmentSchema, async (body) =>
    respond(c, await createDepartment(organizationId, userId, body), "Department created", 201),
  ),
);

export const updateDepartmentController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "departmentId", (id) =>
    withBody(c, updateDepartmentSchema, async (body) =>
      respond(c, await updateDepartment(organizationId, userId, id, body), "Department updated"),
    ),
  ),
);

export const deleteDepartmentController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "departmentId", async (id) =>
    respond(c, await deleteDepartment(organizationId, userId, id), "Department deleted"),
  ),
);

export const listShiftsController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listShifts(organizationId, userId), "Shifts fetched"),
);

export const createShiftController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createShiftSchema, async (body) =>
    respond(c, await createShift(organizationId, userId, body), "Shift created", 201),
  ),
);

export const updateShiftController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "shiftId", (id) =>
    withBody(c, updateShiftSchema, async (body) =>
      respond(c, await updateShift(organizationId, userId, id, body), "Shift updated"),
    ),
  ),
);

export const deleteShiftController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "shiftId", async (id) =>
    respond(c, await deleteShift(organizationId, userId, id), "Shift deleted"),
  ),
);
