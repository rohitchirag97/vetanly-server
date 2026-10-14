import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  addTaskController,
  cancelExitController,
  completeExitController,
  deleteDocumentController,
  deleteTaskController,
  documentUrlController,
  getExitController,
  getProfileController,
  listDocumentsController,
  listTasksController,
  saveExitController,
  saveProfileController,
  startChecklistController,
  updateTaskController,
  uploadDocumentController,
} from "@/controller/employee-record.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const employeeRecordRoutes: Hono = new Hono();

const uploadLimit = bodyLimit({
  maxSize: 6 * 1024 * 1024,
  onError: (c) => c.json({ status: "error", message: "The file is too large", data: null }, 413),
});

employeeRecordRoutes.get("/:employeeId/profile", authenticate, getProfileController);
employeeRecordRoutes.put("/:employeeId/profile", authenticate, saveProfileController);

employeeRecordRoutes.get("/:employeeId/documents", authenticate, listDocumentsController);
employeeRecordRoutes.post("/:employeeId/documents", authenticate, uploadLimit, uploadDocumentController);
employeeRecordRoutes.get("/:employeeId/documents/:documentId/url", authenticate, documentUrlController);
employeeRecordRoutes.delete("/:employeeId/documents/:documentId", authenticate, deleteDocumentController);

employeeRecordRoutes.get("/:employeeId/tasks", authenticate, listTasksController);
employeeRecordRoutes.post("/:employeeId/tasks/start", authenticate, startChecklistController);
employeeRecordRoutes.post("/:employeeId/tasks", authenticate, addTaskController);
employeeRecordRoutes.patch("/:employeeId/tasks/:taskId", authenticate, updateTaskController);
employeeRecordRoutes.delete("/:employeeId/tasks/:taskId", authenticate, deleteTaskController);

employeeRecordRoutes.get("/:employeeId/exit", authenticate, getExitController);
employeeRecordRoutes.put("/:employeeId/exit", authenticate, saveExitController);
employeeRecordRoutes.post("/:employeeId/exit/complete", authenticate, completeExitController);
employeeRecordRoutes.post("/:employeeId/exit/cancel", authenticate, cancelExitController);

export default employeeRecordRoutes;
