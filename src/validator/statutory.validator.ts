import { z } from "zod";

const optionalText = (max: number, pattern?: RegExp, message?: string) => {
  let schema = z.string().trim().max(max);
  if (pattern) schema = schema.regex(pattern, message);
  return schema.nullable().optional().transform((value) => value || null);
};

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

export const updateStatutorySettingsSchema = z
  .object({
    pfEnabled: z.boolean(),
    pfWageCeiling: z.number().min(1).max(10_000_000).default(15_000),
    pfCapWages: z.boolean().default(true),
    pfEstablishmentCode: optionalText(32),
    esiEnabled: z.boolean(),
    esiWageCeiling: z.number().min(1).max(10_000_000).default(21_000),
    esiEstablishmentCode: optionalText(32),
    ptEnabled: z.boolean(),
    ptState: z.enum(["MH", "KA", "WB", "GJ", "TG", "AP", "FLAT"]).nullable().optional(),
    ptFlatAmount: z.number().min(0).max(2_500).nullable().optional(),
    tdsEnabled: z.boolean(),
    tan: optionalText(10, TAN, "TAN looks like ABCD12345E"),
    employerPan: optionalText(10, PAN, "PAN looks like ABCDE1234F"),
    employerAddress: optionalText(300),
  })
  .refine((value) => !value.ptEnabled || value.ptState, {
    message: "Choose the state for professional tax",
    path: ["ptState"],
  })
  .refine((value) => value.ptState !== "FLAT" || value.ptFlatAmount, {
    message: "Enter the monthly professional tax amount",
    path: ["ptFlatAmount"],
  });

export const updateEmployeeStatutorySchema = z.object({
  uan: z.string().trim().regex(/^\d{12}$/, "UAN is 12 digits").or(z.literal("")).optional(),
  esiNumber: z.string().trim().regex(/^\d{10,17}$/, "ESI number is 10 to 17 digits").or(z.literal("")).optional(),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PAN, "PAN looks like ABCDE1234F")
    .or(z.literal(""))
    .optional(),
  gender: z.enum(["male", "female", "other", ""]).optional(),
  pfApplicable: z.boolean().optional(),
  esiApplicable: z.boolean().optional(),
  taxRegime: z.enum(["new", "old"]).optional(),
  declaredDeductions: z.number().min(0).max(100_000_000).optional(),
});
