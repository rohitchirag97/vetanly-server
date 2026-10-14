import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

export const createKioskSchema = z.object({
  deviceIdentifier: z.string().trim().min(1, "Device identifier is required").max(100),
  name: z.string().trim().min(1, "Name is required").max(100),
  locationName: text(100),
});

export const updateKioskSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    locationName: text(100),
    isActive: z.boolean().optional(),
    faceMatchThreshold: z.number().min(0).max(1).nullable().optional(),
    requireLiveness: z.boolean().optional(),
    faceModelName: z.string().trim().min(1).max(64).nullable().optional(),
    faceModelVersion: z.string().trim().min(1).max(32).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

const eventType = z.enum(["check_in", "check_out"]);
const timestamp = z.iso.datetime({ offset: true });

export const kioskAttendanceSchema = z.object({
  employeeId: z.uuid(),
  eventType,
  // The kiosk's own clock reading and UTC offset, so the local day is unambiguous.
  occurredAt: timestamp,
  utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
  externalEventId: z.string().trim().min(1).max(100).optional(),
  faceMatchScore: z.number().min(0).max(1).optional(),
  livenessPassed: z.boolean().optional(),
  faceTemplateId: z.uuid().optional(),
});

export const manualAttendanceSchema = z.object({
  employeeId: z.uuid(),
  eventType,
  occurredAt: timestamp,
  utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
}); 

export const bulkManualAttendanceSchema = z
  .object({
    date: z.iso.date(),
    utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
    leaveTypeId: z.uuid().optional(),
    entries: z
      .array(
        z.object({
          employeeId: z.uuid(),
          status: z.enum(["present", "half_day", "on_leave", "absent"]),
          overtimeMinutes: z.number().int().min(0).max(720).default(0),
        }),
      )
      .min(1, "Mark at least one employee")
      .max(500),
  })
  .refine((v) => !v.entries.some((e) => e.status === "on_leave") || v.leaveTypeId, {
    message: "Choose a leave type for employees marked on leave",
    path: ["leaveTypeId"],
  });

export const dailyAttendanceQuerySchema = z.object({
  employeeId: z.uuid().optional(),
  from: z.iso.date(),
  to: z.iso.date(),
  utcOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
});

export const listAttendanceQuerySchema = z.object({
  employeeId: z.uuid().optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
