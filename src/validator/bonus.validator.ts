import { z } from "zod";

import { BONUS_MAX_PERCENT, BONUS_MIN_PERCENT } from "@/services/bonus-calc";

export const calculateBonusSchema = z.object({
  financialYear: z.string().regex(/^\d{4}-\d{2}$/, "Financial year looks like 2025-26"),
  percentage: z.number().min(BONUS_MIN_PERCENT, `The bonus is at least ${BONUS_MIN_PERCENT}%`).max(BONUS_MAX_PERCENT, `The bonus is at most ${BONUS_MAX_PERCENT}%`),
  eligibilityCeiling: z.number().positive().max(10_000_000),
  calculationCeiling: z.number().positive().max(10_000_000),
  payout: z.enum(["payroll", "direct"]),
}).refine((value) => Number(value.financialYear.slice(5)) === (Number(value.financialYear.slice(0, 4)) + 1) % 100, {
  message: "Financial year looks like 2025-26",
  path: ["financialYear"],
});

export const updateBonusItemSchema = z
  .object({
    finalAmount: z.number().min(0).max(100_000_000).multipleOf(0.01).optional(),
    included: z.boolean().optional(),
  })
  .refine((value) => value.finalAmount !== undefined || value.included !== undefined, "Nothing to change");

export const markBonusPaidSchema = z.object({
  paymentReference: z.string().trim().max(120).optional(),
  paidOn: z.iso.date().optional(),
});

export const gratuityQuerySchema = z.object({ asOf: z.iso.date().optional() });
