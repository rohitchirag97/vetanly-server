import { z } from "zod";

const MAX_PERIOD_DAYS = 62;

export const generatePayrollSchema = z
  .object({
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
  })
  .refine((v) => v.periodStart <= v.periodEnd, {
    message: "Period end must be on or after period start",
    path: ["periodEnd"],
  })
  .refine(
    (v) =>
      (Date.parse(v.periodEnd) - Date.parse(v.periodStart)) / 86_400_000 < MAX_PERIOD_DAYS,
    { message: `Pay period cannot exceed ${MAX_PERIOD_DAYS} days`, path: ["periodEnd"] },
  );
