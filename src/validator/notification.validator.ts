import { z } from "zod";

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  before: z.iso.datetime().optional(),
  unreadOnly: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const markReadSchema = z.object({
  ids: z.union([z.literal("all"), z.array(z.uuid()).min(1).max(100)]),
});
