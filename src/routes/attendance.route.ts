import { Hono } from "hono";

import {
  dailyAttendanceController,
  dailyAttendancePageController,
  kioskAttendanceController,
  listAttendanceController,
  manualAttendanceController,
  bulkManualAttendanceController,
  gpsAttendanceController,
  gpsStatusController,
} from "@/controller/kiosk-attendance.controller";
import { authenticate } from "@/middleware/authenticate.middleware";
import { authenticateKioskMiddleware } from "@/middleware/authenticate-kiosk.middleware";

const attendanceRoutes: Hono = new Hono();

attendanceRoutes.post("/kiosk", authenticateKioskMiddleware, kioskAttendanceController);
attendanceRoutes.post("/manual", authenticate, manualAttendanceController);
attendanceRoutes.post("/manual/bulk", authenticate, bulkManualAttendanceController);
attendanceRoutes.get("/daily", authenticate, dailyAttendanceController);
attendanceRoutes.get("/daily/page", authenticate, dailyAttendancePageController);
attendanceRoutes.get("/gps", authenticate, gpsStatusController);
attendanceRoutes.post("/gps", authenticate, gpsAttendanceController);
attendanceRoutes.get("/", authenticate, listAttendanceController);

export default attendanceRoutes;
