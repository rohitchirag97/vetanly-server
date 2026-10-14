import { z } from "zod";

export const reportQuerySchema = z
  .object({
    type: z.enum(["attendance", "leave", "payroll", "loans", "pf", "esi", "pt", "tds", "form16"]),
    format: z.enum(["xlsx", "pdf", "ecr"]),
    from: z.iso.date().default("1970-01-01"),
    to: z.iso.date().default("2999-12-31"),
    runId: z.uuid().optional(),
    employeeId: z.uuid().optional(),
    fy: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    utcOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
  })
  .refine((value) => value.from <= value.to, { message: "From date must be before the to date" })
  .refine((value) => value.format !== "ecr" || value.type === "pf", {
    message: "ECR is only available for the provident fund report",
  })
  .refine(
    (value) =>
      value.type !== "attendance" ||
      (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 92,
    { message: "Attendance reports are limited to 93 days" },
  );
