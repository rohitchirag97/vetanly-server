import { z } from "zod";

export const platformOrganizationsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["active", "suspended", "pending_deletion"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const createPlatformOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(52),
  slug: z.string().trim().min(1).max(52).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  owner: z.object({
    fname: z.string().trim().min(1).max(52),
    lname: z.string().trim().min(1).max(52),
    phone: z.string().regex(/^\d{11,15}$/),
    email: z.union([z.email(), z.literal("")]).optional(),
  }),
});

export const suspendOrganizationSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const platformNoteSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export const platformOtpSchema = z.object({
  otp: z.string().regex(/^\d{6}$/),
});

export const platformAuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
