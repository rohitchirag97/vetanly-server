import { z } from "zod";

export const settlementInputsSchema = z.object({
  salaryFrom: z.iso.date(),
  encashDays: z.number().min(0).max(365),
  dailyRate: z.number().min(0).max(10_000_000).multipleOf(0.01),
  includeGratuity: z.boolean(),
  waiveNoticeRecovery: z.boolean(),
  extraLines: z
    .array(
      z.object({
        kind: z.enum(["other_earning", "other_deduction"]),
        label: z.string().trim().min(1, "Describe each extra line").max(120),
        amount: z.number().positive().max(100_000_000).multipleOf(0.01),
      }),
    )
    .max(20)
    .default([]),
  utcOffsetMinutes: z.number().int().min(-840).max(840).default(330),
});

export const markSettlementPaidSchema = z.object({
  paymentMethod: z.enum(["bank_transfer", "upi", "cheque", "cash", "other"]),
  paymentReference: z.string().trim().max(120).optional(),
  paidOn: z.iso.date().optional(),
});
