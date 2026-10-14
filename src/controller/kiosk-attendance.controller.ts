import type { Context } from "hono";

import {
  getDailyAttendance,
  listAttendance,
  recordBulkManualAttendance,
  recordKioskAttendance,
  recordManualAttendance,
} from "@/services/attendance.services";
import {
  createKiosk,
  listKiosks,
  rotateKioskKey,
  updateKiosk,
} from "@/services/kiosk.services";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { respond, ok } from "@/utils/result";
import {
  bulkManualAttendanceSchema,
  createKioskSchema,
  dailyAttendanceQuerySchema,
  kioskAttendanceSchema,
  listAttendanceQuerySchema,
  manualAttendanceSchema,
  updateKioskSchema,
} from "@/validator/kiosk-attendance.validator";

export const listKiosksController = withOrganization(async (c, { organizationId, userId }) =>
  respond(c, await listKiosks(organizationId, userId), "Kiosks fetched"),
);

export const createKioskController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, createKioskSchema, async (body) =>
    respond(c, await createKiosk(organizationId, userId, body), "Kiosk created", 201),
  ),
);

export const updateKioskController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "kioskId", (id) =>
    withBody(c, updateKioskSchema, async (body) =>
      respond(c, await updateKiosk(organizationId, userId, id, body), "Kiosk updated"),
    ),
  ),
);

export const rotateKioskKeyController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "kioskId", async (id) =>
    respond(c, await rotateKioskKey(organizationId, userId, id), "Kiosk key rotated"),
  ),
);

export const kioskHeartbeatController = async (c: Context) => {
  const offset = Number(c.req.query("utcOffsetMinutes") ?? 0);
  const utcOffsetMinutes = Number.isInteger(offset) && Math.abs(offset) <= 840 ? offset : 0;
  const now = new Date();
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const hour24 = local.getUTCHours();
  const minute = String(local.getUTCMinutes()).padStart(2, "0");
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return respond(
    c,
    ok({
      kioskId: c.get("kiosk").id,
      serverTime: now,
      utcOffsetMinutes,
      date: local.toISOString().slice(0, 10),
      time: `${hour12}:${minute}`,
      period,
      time12Hour: `${hour12}:${minute} ${period}`,
    }),
    "OK",
  );
};

export const kioskAttendanceController = (c: Context) =>
  withBody(c, kioskAttendanceSchema, async (body) =>
    respond(c, await recordKioskAttendance(c.get("kiosk"), body), "Attendance accepted", 202),
  );

export const manualAttendanceController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, manualAttendanceSchema, async (body) =>
    respond(
      c,
      await recordManualAttendance(organizationId, userId, body),
      "Attendance recorded",
      201,
    ),
  ),
);

export const bulkManualAttendanceController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, bulkManualAttendanceSchema, async (body) =>
    respond(
      c,
      await recordBulkManualAttendance(organizationId, userId, body),
      "Bulk attendance processed",
      200,
    ),
  ),
);

export const dailyAttendanceController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, dailyAttendanceQuerySchema, async (query) =>
    respond(c, await getDailyAttendance(organizationId, userId, query), "Daily attendance fetched"),
  ),
);

export const listAttendanceController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listAttendanceQuerySchema, async (query) =>
    respond(c, await listAttendance(organizationId, userId, query), "Attendance fetched"),
  ),
);
