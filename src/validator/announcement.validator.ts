import { z } from "zod";

export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(160),
  body: z.string().trim().min(1, "Message is required").max(2000),
});

export const listAnnouncementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
