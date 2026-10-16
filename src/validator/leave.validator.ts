import { z } from "zod";

const carryForwardMaxDays = z.number().min(0).max(366).nullable().optional();
const compOffValidityDays = z.number().int().min(1).max(366).nullable().optional();

export const createLeaveTypeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  isPaid: z.boolean().default(true),
  annualAllowanceDays: z.number().min(0).max(366).nullable().optional(),
  carryForwardMaxDays,
  isCompOff: z.boolean().default(false),
  compOffValidityDays,
});

export const updateLeaveTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isPaid: z.boolean().optional(),
    annualAllowanceDays: z.number().min(0).max(366).nullable().optional(),
    carryForwardMaxDays,
    isCompOff: z.boolean().optional(),
    compOffValidityDays,
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

const utcOffsetMinutes = z.number().int().min(-840).max(840).default(0);

export const offDayWorkQuerySchema = z.object({
  mine: z.stringbool().optional(),
  utcOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
});

export const requestOffDayOutcomeSchema = z.object({
  date: z.iso.date(),
  outcome: z.enum(["comp_off", "pay"]),
  utcOffsetMinutes,
});

export const decideOffDayWorkSchema = z.object({
  employeeId: z.uuid(),
  date: z.iso.date(),
  outcome: z.enum(["comp_off", "pay", "none"]),
  leaveTypeId: z.uuid().optional(),
  utcOffsetMinutes,
});

export const leaveCreditQuerySchema = z.object({
  employeeId: z.uuid().optional(),
  utcOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
});

export const listLeaveQuerySchema = z.object({
  employeeId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
});
