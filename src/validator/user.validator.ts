import z from "zod";

// Phone and email change only through the verified linking endpoints, never here.
export const updateUserSchema = z
  .object({
    fname: z.string().trim().min(1).max(52).optional(),
    lname: z.string().trim().min(1).max(52).optional(),
  })
  .refine((updates) => Object.keys(updates).length > 0, {
    message: "Provide at least one field to update",
  });
