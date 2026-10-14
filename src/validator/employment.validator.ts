import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code");

export const salaryComponentSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    kind: z.enum(["earning", "deduction"]),
    calc: z.enum(["fixed", "percent_basic"]),
    value: z.number().min(0).max(9_999_999_999.99),
  })
  .refine((c) => c.calc !== "percent_basic" || c.value <= 100, {
    message: "A percentage cannot be more than 100",
    path: ["value"],
  });

export const updateEmploymentSchema = z
  .object({
    employeeCode: text(32),
    jobTitle: text(100),
    departmentId: z.uuid().nullable().optional(),
    shiftId: z.uuid().nullable().optional(),
    employmentType: z
      .enum(["full_time", "part_time", "contractor", "intern"])
      .nullable()
      .optional(),
    hireDate: z.iso.date().nullable().optional(),
    compensationType: z.enum(["hourly", "daily", "fixed_salary"]).nullable().optional(),
    compensationAmount: z.number().min(0).max(9_999_999_999.99).nullable().optional(),
    compensationCurrency: currency.nullable().optional(),
    payFrequency: z
      .enum(["weekly", "biweekly", "semimonthly", "monthly"])
      .nullable()
      .optional(),
    salaryComponents: z.array(salaryComponentSchema).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update");

export const payrollInclusionSchema = z.object({ includeInPayroll: z.boolean() });
