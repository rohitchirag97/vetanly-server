import type { Context } from "hono";

import {
  canEditAttendance,
  getDailyAttendance,
  getGpsStatus,
  recordGpsAttendance,
  listAttendance,
  recordBulkManualAttendance,
  recordKioskAttendance,
  recordManualAttendance,
} from "@/services/attendance.services";
import {
  claimPairingCode,
  createKiosk,
  createKioskCode,
  unlockEnrollment,
  unpairKiosk,
  listKiosks,
  rotateKioskKey,
  updateKiosk,
} from "@/services/kiosk.services";
import { clientIp } from "@/middleware/audit.middleware";
import { withBody, withOrganization, withParam, withQuery } from "@/utils/controller";
import { incrementWithExpiry } from "@/utils/redis";
import { sendResponse } from "@/utils/response";
import { respond, ok } from "@/utils/result";
import {
  bulkManualAttendanceSchema,
  claimPairingCodeSchema,
  createKioskSchema,
  dailyAttendancePageQuerySchema,
  dailyAttendanceQuerySchema,
  gpsAttendanceSchema,
  gpsStatusQuerySchema,
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

export const createPairingCodeController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "kioskId", async (id) =>
    respond(c, await createKioskCode(organizationId, userId, id, "pair"), "Pairing code created", 201),
  ),
);

export const unpairKioskController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "kioskId", async (id) =>
    respond(c, await unpairKiosk(organizationId, userId, id), "Kiosk unpaired"),
  ),
);

export const createEnrollmentCodeController = withOrganization((c, { organizationId, userId }) =>
  withParam(c, "kioskId", async (id) =>
    respond(c, await createKioskCode(organizationId, userId, id, "enroll"), "Enrollment code created", 201),
  ),
);

export const unlockEnrollmentController = async (c: Context) => {
  const kiosk = c.get("kiosk");
  const attempts = await incrementWithExpiry(`kiosk-enroll-attempts:${kiosk.id}`, 900);
  if (attempts > MAX_PAIRING_ATTEMPTS) {
    return sendResponse(c, "error", "Too many attempts. Try again in 15 minutes.", null, 429);
  }
  return withBody(c, claimPairingCodeSchema, async ({ code }) =>
    respond(c, await unlockEnrollment(kiosk, code), "Enrollment unlocked"),
  );
};

const MAX_PAIRING_ATTEMPTS = 10;

export const claimPairingCodeController = async (c: Context) => {
  // Unauthenticated and only 10^6 codes, so cap guesses per address.
  const attempts = await incrementWithExpiry(`kiosk-pair-attempts:${clientIp(c) ?? "unknown"}`, 900);
  if (attempts > MAX_PAIRING_ATTEMPTS) {
    return sendResponse(c, "error", "Too many attempts. Try again in 15 minutes.", null, 429);
  }
  return withBody(c, claimPairingCodeSchema, async ({ code }) =>
    respond(c, await claimPairingCode(code), "Kiosk paired"),
  );
};

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

export const dailyAttendancePageController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, dailyAttendancePageQuerySchema, async ({ status, limit, offset, ...query }) => {
    const result = await getDailyAttendance(organizationId, userId, query);
    if (!result.ok) return respond(c, result, "");
    const rows = status ? result.data.filter((day) => day.status === status) : result.data;
    const canEdit = await canEditAttendance(organizationId, userId);
    return respond(c, ok({ rows: rows.slice(offset, offset + limit), total: rows.length, canEdit }), "Daily attendance fetched");
  }),
);

export const listAttendanceController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, listAttendanceQuerySchema, async (query) =>
    respond(c, await listAttendance(organizationId, userId, query), "Attendance fetched"),
  ),
);

export const gpsStatusController = withOrganization((c, { organizationId, userId }) =>
  withQuery(c, gpsStatusQuerySchema, async (query) =>
    respond(c, await getGpsStatus(organizationId, userId, query.utcOffsetMinutes), "GPS check-in status fetched"),
  ),
);

export const gpsAttendanceController = withOrganization((c, { organizationId, userId }) =>
  withBody(c, gpsAttendanceSchema, async (body) =>
    respond(c, await recordGpsAttendance(organizationId, userId, body), body.eventType === "check_in" ? "Checked in" : "Checked out", 201),
  ),
);
