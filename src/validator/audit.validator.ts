import { z } from "zod";

export const listAuditLogsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(5),
});
