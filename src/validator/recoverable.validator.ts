import { z } from "zod";

const money = z.number().max(9_999_999_999.99);
const text = (max: number) => z.string().trim().min(1).max(max).optional();

export const createRecoverableSchema = z
  .object({
    employeeId: z.uuid().optional(),
    type: z.enum(["loan", "salary_advance"]),
    principalAmount: money.gt(0),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code")
      .optional(),
    annualInterestRate: z.number().min(0).max(100).default(0),
    installmentCount: z.number().int().min(1).max(600).optional(),
    installmentAmount: money.gt(0).optional(),
    firstRepaymentDate: z.iso.date().optional(),
    description: text(500),
  })
  .refine(
    (value) =>
      (value.installmentCount === undefined) ===
      (value.installmentAmount === undefined),
    { message: "Provide both installment count and installment amount" },
  );

export const updateRecoverableStatusSchema = z.object({
  status: z.enum(["approved", "rejected", "cancelled", "disbursed"]),
  annualInterestRate: z.number().min(0).max(100).optional(),
});

export const listRecoverablesQuerySchema = z.object({
  employeeId: z.uuid().optional(),
  type: z.enum(["loan", "salary_advance"]).optional(),
  status: z
    .enum([
      "pending",
      "approved",
      "disbursed",
      "active",
      "completed",
      "rejected",
      "cancelled",
    ])
    .optional(),
});

const paymentMethod = z.enum(["cash", "bank_transfer", "upi", "cheque", "other"]);

export const createRepaymentSchema = z
  .object({
    amount: money.gt(0),
    source: z.enum(["payroll", "manual"]).default("manual"),
    paymentMethod: paymentMethod.optional(),
    paidAt: z.iso.datetime({ offset: true }).optional(),
    payrollPeriodStart: z.iso.date().optional(),
    payrollPeriodEnd: z.iso.date().optional(),
    reference: text(100),
    notes: text(500),
  })
  .refine(
    (value) =>
      !value.payrollPeriodStart ||
      !value.payrollPeriodEnd ||
      value.payrollPeriodStart <= value.payrollPeriodEnd,
    { message: "Payroll period start must not be after its end" },
  );

export const reviewRepaymentSchema = z.object({
  status: z.enum(["confirmed", "rejected"]),
  reviewNote: text(500),
});
