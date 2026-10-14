import { Hono } from "hono";

import {
  createDepartmentController,
  deleteDepartmentController,
  listDepartmentsController,
  updateDepartmentController,
} from "@/controller/department-shift.controller";
import { authenticate } from "@/middleware/authenticate.middleware";

const departmentRoutes: Hono = new Hono();

departmentRoutes.get("/", authenticate, listDepartmentsController);
departmentRoutes.post("/", authenticate, createDepartmentController);
departmentRoutes.patch("/:departmentId", authenticate, updateDepartmentController);
departmentRoutes.delete("/:departmentId", authenticate, deleteDepartmentController);

export default departmentRoutes;
