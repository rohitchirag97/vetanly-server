import { z } from "zod";
import { UserRole } from "@/drizzle/schema";

export const createEmployeeSchema = z.object({
  fname: z.string().trim().min(1, "First name is required").max(52),
  lname: z.string().trim().min(1, "Last name is required").max(52),
  phone: z
    .string()
    .regex(/^\d{11,15}$/, "Include a valid country code and phone number"),
  role: z.enum([UserRole.ADMIN, UserRole.HR, UserRole.EMPLOYEE]),
  organizationId: z.uuid(),
});

export const bulkCreateEmployeesSchema = z.object({
  organizationId: z.uuid(),
  employees: z
    .array(
      z.object({
        fname: z.string().trim().min(1, "First name is required").max(52),
        lname: z.string().trim().min(1, "Last name is required").max(52),
        phone: z.string().regex(/^\d{11,15}$/, "Include a valid country code and phone number"),
        role: z.enum([UserRole.ADMIN, UserRole.HR, UserRole.EMPLOYEE]),
      }),
    )
    .min(1, "Add at least one employee")
    .max(500, "Upload at most 500 employees at a time"),
});

export const bulkCheckEmployeesSchema = z.object({
  organizationId: z.uuid(),
  phones: z.array(z.string().regex(/^\d{11,15}$/)).max(500, "Check at most 500 employees at a time"),
  employeeCodes: z.array(z.string().trim().min(1).max(32)).max(500).default([]),
});

export const updateEmployeeSchema = z.object({
  organizationId: z.uuid(),
  fname: z.string().trim().min(1, "First name is required").max(52),
  lname: z.string().trim().min(1, "Last name is required").max(52),
  role: z.enum([UserRole.ADMIN, UserRole.HR, UserRole.EMPLOYEE]),
});

export const updateEmployeeStatusSchema = z
  .object({
    organizationId: z.uuid(),
    isActive: z.boolean(),
    reason: z.string().trim().max(500, "Reason must be 500 characters or fewer").optional(),
  })
  .refine((value) => value.isActive || (value.reason?.length ?? 0) >= 3, {
    message: "A reason is required to deactivate an employee",
    path: ["reason"],
  });

export const removeEmployeeSchema = z.object({
  organizationId: z.uuid(),
});
