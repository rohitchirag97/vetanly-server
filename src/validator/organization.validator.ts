import z from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Organization name is required").max(52),
  slug: z
    .string()
    .trim()
    .min(1, "Organization slug is required")
    .max(52)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens"),
});

export const updateOrganizationSchema = createOrganizationSchema;
