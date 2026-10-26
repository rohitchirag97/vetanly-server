import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm");

export const createRegularizationSchema = z
  .object({
    date: z.iso.date(),
    checkIn: time.optional(),
    checkOut: time.optional(),
    reason: z.string().trim().min(3, "Please give a reason").max(500),
    utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
  })
  .refine((value) => value.checkIn || value.checkOut, {
    message: "Provide a check-in time, a check-out time, or both",
  })
  .refine((value) => !value.checkIn || !value.checkOut || value.checkOut > value.checkIn, {
    message: "Check-out must be after check-in",
  });

export const editAttendanceSchema = z
  .object({
    employeeId: z.uuid(),
    date: z.iso.date(),
    checkIn: time.optional(),
    checkOut: time.optional(),
    reason: z.string().trim().min(3, "Please give a reason").max(500).optional(),
    utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
  })
  .refine((value) => value.checkIn || value.checkOut, {
    message: "Provide a check-in time, a check-out time, or both",
  })
  .refine((value) => !value.checkIn || !value.checkOut || value.checkOut > value.checkIn, {
    message: "Check-out must be after check-in",
  });

export const updateRegularizationStatusSchema = z.object({
  status: z.enum(["approved", "rejected", "cancelled"]),
  reviewNote: z.string().trim().min(1).max(500).optional(),
});

export const listRegularizationQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
  mine: z.enum(["true", "false"]).optional(),
});
