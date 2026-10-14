import { z } from "zod";

export const createLeaveTypeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  isPaid: z.boolean().default(true),
  annualAllowanceDays: z.number().min(0).max(366).nullable().optional(),
});

export const updateLeaveTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isPaid: z.boolean().optional(),
    annualAllowanceDays: z.number().min(0).max(366).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

export const createLeaveRequestSchema = z
  .object({
    employeeId: z.uuid().optional(),
    leaveTypeId: z.uuid(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    isHalfDay: z.boolean().default(false),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: "End date cannot be before start date",
  })
  .refine((value) => !value.isHalfDay || value.startDate === value.endDate, {
    message: "A half day leave must be a single date",
  });

export const updateLeaveStatusSchema = z.object({
  status: z.enum(["approved", "rejected", "cancelled"]),
  reviewNote: z.string().trim().min(1).max(500).optional(),
});

export const listLeaveQuerySchema = z.object({
  employeeId: z.uuid().optional(),
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
});
