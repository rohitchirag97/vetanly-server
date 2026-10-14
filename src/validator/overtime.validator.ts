import { z } from "zod";

export const listOvertimeQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    status: z.enum(["pending", "approved", "rejected", "auto"]).optional(),
    utcOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
  })
  .refine((value) => value.from <= value.to, { message: "From date must be before the to date" })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 92, {
    message: "Choose a range of at most 93 days",
  });

export const reviewOvertimeSchema = z.object({
  entries: z
    .array(
      z.object({
        employeeId: z.uuid(),
        date: z.iso.date(),
        status: z.enum(["approved", "rejected"]),
        approvedMinutes: z.number().int().min(1).max(1440).optional(),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(100),
  utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
});
