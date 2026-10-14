import { z } from "zod";

export const rotationSchema = z.object({
  name: z.string().trim().min(1, "Name the rotation").max(100),
  pattern: z
    .array(
      z.object({
        // null is a day off.
        shiftId: z.uuid().nullable(),
        days: z.number().int().min(1, "Each step needs at least one day").max(31),
      }),
    )
    .min(1, "Add at least one step")
    .max(20),
  isActive: z.boolean().default(true),
});

export const assignRotationSchema = z.object({
  rotationId: z.uuid(),
  employeeIds: z.array(z.uuid()).min(1, "Choose at least one employee").max(500),
  startsOn: z.iso.date(),
  // Which day of the cycle the start date falls on (0 = first day), to stagger crews.
  cycleOffset: z.number().int().min(0).default(0),
});

export const endRotationSchema = z.object({
  employeeIds: z.array(z.uuid()).min(1).max(500),
  fromDate: z.iso.date(),
});

export const overrideSchema = z.object({
  employeeId: z.uuid(),
  date: z.iso.date(),
  // A null shift (with clear false) sets a day off; clear true removes the override.
  shiftId: z.uuid().nullable().optional(),
  clear: z.boolean().default(false),
  note: z.string().trim().max(200).optional(),
});

const MAX_RANGE_DAYS = 42;
export const rangeQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date(), departmentId: z.uuid().optional() })
  .refine((q) => q.from <= q.to, { message: "The end date must be after the start date" })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_RANGE_DAYS, {
    message: `Show at most ${MAX_RANGE_DAYS} days at a time`,
  });

export const swapRequestSchema = z.object({
  colleagueId: z.uuid(),
  date: z.iso.date(),
  reason: z.string().trim().max(300).optional(),
});

export const swapDecisionSchema = z.object({ accept: z.boolean() });
export const swapReviewSchema = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() });
export const swapListQuerySchema = z.object({
  status: z.enum(["awaiting_colleague", "awaiting_manager", "approved", "rejected", "cancelled"]).optional(),
});
export const swapOptionsQuerySchema = z.object({ date: z.iso.date() });
