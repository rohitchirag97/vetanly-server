import { z } from "zod";

export const insightsRangeSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((value) => value.from <= value.to, { message: "The from date must be before the to date", path: ["to"] })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 92, {
    message: "Attendance insights cover at most 93 days at a time",
    path: ["to"],
  });
