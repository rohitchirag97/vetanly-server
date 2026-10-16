import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Invalid date");

export const MAX_HOLIDAY_RANGE_DAYS = 31;

export const createHolidaySchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    date: isoDate,
    endDate: isoDate.optional(),
    // Only this branch has the day off; leave out for every branch.
    branchId: z.uuid().optional(),
  })
  .refine((value) => !value.endDate || value.endDate >= value.date, {
    message: "End date must not be before the start date",
  })
  .refine(
    (value) =>
      !value.endDate ||
      (Date.parse(value.endDate) - Date.parse(value.date)) / 86_400_000 < MAX_HOLIDAY_RANGE_DAYS,
    { message: `A holiday range can be at most ${MAX_HOLIDAY_RANGE_DAYS} days` },
  );

export const updateHolidaySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

export const listHolidaysQuerySchema = z.object({
  organizationId: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  branchId: z.uuid().optional(),
  // "true": a manager asking for the holidays that apply to themselves.
  mine: z.enum(["true", "false"]).optional(),
});
