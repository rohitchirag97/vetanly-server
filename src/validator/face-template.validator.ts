import { z } from "zod";

const score = z.number().min(0).max(1);

export const enrollFaceTemplateSchema = z.object({
  employeeId: z.uuid(),
  embedding: z
    .array(z.number().finite())
    .min(16, "Embedding is too short")
    .max(2048, "Embedding is too long"),
  modelName: z.string().trim().min(1).max(64),
  modelVersion: z.string().trim().min(1).max(32),
  qualityScore: score.optional(),
});

export const syncFaceTemplatesQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
});

export const kioskDeviceInfoSchema = z.object({
  appVersion: z.string().trim().min(1).max(32).optional(),
  faceModelName: z.string().trim().min(1).max(64).optional(),
  faceModelVersion: z.string().trim().min(1).max(32).optional(),
});
