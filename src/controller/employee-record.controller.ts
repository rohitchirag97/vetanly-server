import {
  deleteEmployeeDocument,
  getEmployeeDocumentUrl,
  listEmployeeDocuments,
  uploadEmployeeDocument,
} from "@/services/employee-document.services";
import {
  addLifecycleTask,
  cancelEmployeeExit,
  completeEmployeeExit,
  deleteLifecycleTask,
  getEmployeeExit,
  listLifecycleTasks,
  saveEmployeeExit,
  setLifecycleTaskDone,
  startChecklist,
} from "@/services/employee-lifecycle.services";
import { getEmployeeProfile, saveEmployeeProfile } from "@/services/employee-profile.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { badRequest, firstIssue } from "@/utils/request";
import { respond } from "@/utils/result";
import {
  createTaskSchema,
  documentFieldsSchema,
  exitSchema,
  profileSchema,
  startChecklistSchema,
  taskKindQuerySchema,
  updateTaskSchema,
} from "@/validator/employee-record.validator";

export const getProfileController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (employeeId) =>
    respond(c, await getEmployeeProfile(organizationId, userId, employeeId), "Profile fetched"),
  ),
);

export const saveProfileController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withBody(c, profileSchema, async (body) =>
      respond(
        c,
        await saveEmployeeProfile(organizationId, userId, employeeId, body),
        "Profile saved",
      ),
    ),
  ),
);

export const listDocumentsController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (employeeId) =>
    respond(c, await listEmployeeDocuments(organizationId, userId, employeeId), "Documents fetched"),
  ),
);

export const uploadDocumentController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (employeeId) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File)) return badRequest(c, "Attach a file");
    const fields = documentFieldsSchema.safeParse({
      docType: form?.docType,
      name: typeof form?.name === "string" ? form.name : undefined,
    });
    if (!fields.success) return badRequest(c, firstIssue(fields.error));
    return respond(
      c,
      await uploadEmployeeDocument(organizationId, userId, employeeId, fields.data, file),
      "Document uploaded",
      201,
    );
  }),
);

export const documentUrlController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withParam(c, "documentId", async (documentId) =>
      respond(
        c,
        await getEmployeeDocumentUrl(organizationId, userId, employeeId, documentId),
        "Download link created",
      ),
    ),
  ),
);

export const deleteDocumentController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withParam(c, "documentId", async (documentId) =>
      respond(
        c,
        await deleteEmployeeDocument(organizationId, userId, employeeId, documentId),
        "Document deleted",
      ),
    ),
  ),
);

export const listTasksController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withQuery(c, taskKindQuerySchema, async ({ kind }) =>
      respond(
        c,
        await listLifecycleTasks(organizationId, userId, employeeId, kind),
        "Checklist fetched",
      ),
    ),
  ),
);

export const startChecklistController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withBody(c, startChecklistSchema, async ({ kind }) =>
      respond(
        c,
        await startChecklist(organizationId, userId, employeeId, kind),
        "Checklist started",
        201,
      ),
    ),
  ),
);

export const addTaskController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withBody(c, createTaskSchema, async (body) =>
      respond(
        c,
        await addLifecycleTask(organizationId, userId, employeeId, body),
        "Task added",
        201,
      ),
    ),
  ),
);

export const updateTaskController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withParam(c, "taskId", (taskId) =>
      withBody(c, updateTaskSchema, async ({ isDone }) =>
        respond(
          c,
          await setLifecycleTaskDone(organizationId, userId, employeeId, taskId, isDone),
          "Task updated",
        ),
      ),
    ),
  ),
);

export const deleteTaskController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withParam(c, "taskId", async (taskId) =>
      respond(
        c,
        await deleteLifecycleTask(organizationId, userId, employeeId, taskId),
        "Task deleted",
      ),
    ),
  ),
);

export const getExitController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (employeeId) =>
    respond(c, await getEmployeeExit(organizationId, userId, employeeId), "Exit fetched"),
  ),
);

export const saveExitController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", (employeeId) =>
    withBody(c, exitSchema, async (body) =>
      respond(c, await saveEmployeeExit(organizationId, userId, employeeId, body), "Exit saved"),
    ),
  ),
);

export const completeExitController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (employeeId) =>
    respond(c, await completeEmployeeExit(organizationId, userId, employeeId), "Exit completed"),
  ),
);

export const cancelExitController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "employeeId", async (employeeId) =>
    respond(c, await cancelEmployeeExit(organizationId, userId, employeeId), "Exit cancelled"),
  ),
);
