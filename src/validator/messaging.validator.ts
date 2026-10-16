import { z } from "zod";

const messageType = z.enum(["salary_slip", "loan_noc", "test"]);
const statusWords = z.array(z.string().trim().min(1).max(40)).max(10).optional();

export const customProviderSchema = z.object({
  name: z.string().trim().min(1, "Give the provider a name").max(80),
  config: z.object({
    url: z.string().trim().url("Enter the provider's full API URL").max(500).refine((u) => u.startsWith("https://") || process.env.NODE_ENV !== "production", "Use an https:// URL"),
    method: z.enum(["POST", "PUT", "GET"]).default("POST"),
    headers: z
      .array(z.object({ name: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "Header names use letters, digits and dashes"), value: z.string().max(1000) }))
      .max(15)
      .default([]),
    bodyTemplate: z.string().max(10_000).default("{}"),
    responseIdPath: z.string().trim().max(200).optional(),
    statusWebhook: z
      .object({
        messageIdPath: z.string().trim().min(1).max(200),
        statusPath: z.string().trim().min(1).max(200),
        errorPath: z.string().trim().max(200).optional(),
        statusMap: z.object({ sent: statusWords, delivered: statusWords, read: statusWords, failed: statusWords }),
      })
      .optional(),
  }),
  // name -> value; null or empty removes it; names left out keep their saved value.
  secrets: z.record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/, "Secret names use letters, digits and _"), z.string().max(2000).nullable()).optional(),
});

export const templateMappingSchema = z.object({
  templates: z
    .array(
      z.object({
        messageType,
        templateName: z.string().trim().min(1, "Enter the template or campaign name").max(120),
        language: z.string().trim().min(2).max(16).default("en"),
        params: z.array(z.string()).max(20),
      }),
    )
    .max(10)
    .refine((list) => new Set(list.map((t) => t.messageType)).size === list.length, "Each message can be mapped once"),
});

export const testMessageSchema = z.object({
  phone: z.string().regex(/^\d{11,15}$/, "Enter the number with country code, digits only (e.g. 919876543210)"),
});

export const lowBalanceSchema = z.object({ threshold: z.number().min(0).max(1_000_000) });

export const topUpRequestSchema = z.object({
  amount: z.number().min(100, "Add at least ₹100").max(1_000_000).multipleOf(0.01),
  note: z.string().trim().max(300).optional(),
});

export const listMessageLogsSchema = z.object({
  status: z.enum(["queued", "sent", "delivered", "read", "failed", "simulated"]).optional(),
  channel: z.enum(["email", "whatsapp"]).optional(),
  messageType: messageType.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const rate = z.number().min(0).max(100);

export const platformRatesSchema = z.object({ email: rate, whatsappVetanly: rate, whatsappCustom: rate });

export const platformOrgMessagingSchema = z.object({
  addonEnabled: z.boolean().optional(),
  // A rate left out follows the platform rate.
  rateOverrides: z.object({ email: rate.optional(), whatsappVetanly: rate.optional(), whatsappCustom: rate.optional() }).optional(),
});

export const platformCreditSchema = z.object({
  amount: z.number().min(-1_000_000).max(1_000_000).multipleOf(0.001).refine((v) => v !== 0, "Enter an amount"),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
  topUpRequestId: z.uuid().optional(),
});
