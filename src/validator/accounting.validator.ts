import { z } from "zod";

const range = {
  from: z.iso.date(),
  to: z.iso.date(),
};

export const accountingRangeSchema = z
  .object(range)
  .refine((value) => value.from <= value.to, { message: "The from date must be before the to date", path: ["to"] })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 400, {
    message: "Export at most about a year at a time",
    path: ["to"],
  });

export const accountingExportSchema = z
  .object({
    ...range,
    format: z.enum(["tally", "csv", "xlsx"]),
    // Only these vouchers (from the preview); all of the period when left out.
    keys: z.array(z.string().max(200)).max(1000).optional(),
    // Tally: also create any missing ledgers under their default groups.
    includeLedgers: z.boolean().default(false),
  })
  .refine((value) => value.from <= value.to, { message: "The from date must be before the to date", path: ["to"] });

export const accountingSettingsSchema = z.object({
  ledgers: z.record(z.string(), z.string().trim().max(100)),
  splitBy: z.enum(["none", "branch", "department"]),
});
