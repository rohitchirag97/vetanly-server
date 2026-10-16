import { config } from "dotenv";
import { expand } from "dotenv-expand";
import { z } from "zod";
import "dotenv/config";
import { buildDatabaseUrl } from "./database-url";
expand(config());

const envSchema = z.object({
  PORT: z.string("PORT is required"),
  // Shared with docker-compose.yml, so the containers and the app always agree.
  POSTGRES_HOST: z.string("POSTGRES_HOST is required"),
  POSTGRES_PORT: z.string("POSTGRES_PORT is required").regex(/^\d+$/, "POSTGRES_PORT must be a number"),
  POSTGRES_USER: z.string("POSTGRES_USER is required"),
  POSTGRES_PASSWORD: z.string("POSTGRES_PASSWORD is required").min(1),
  POSTGRES_DB: z.string("POSTGRES_DB is required"),
  JWT_SECRET: z.string("JWT_SECRET is required"),
  JWT_ACCESS_EXPIRES_IN: z.string("JWT_ACCESS_EXPIRES_IN is required"),
  JWT_REFRESH_EXPIRES_IN: z.string("JWT_REFRESH_EXPIRES_IN is required"),
  REDIS_HOST: z.string("REDIS_HOST is required"),
  REDIS_PORT: z.string("REDIS_PORT is required").regex(/^\d+$/, "REDIS_PORT must be a number"),
  REDIS_PASSWORD: z.string("REDIS_PASSWORD is required").min(1, "REDIS_PASSWORD is required"),
  BANK_ENCRYPTION_KEY: z
    .string("BANK_ENCRYPTION_KEY is required")
    .regex(/^[0-9a-fA-F]{64}$/, "BANK_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  // Vetanly's own WhatsApp service (a separate project). Unset: messages are only logged.
  VETANLY_WHATSAPP_URL: z.string().url().optional().or(z.literal("")),
  VETANLY_WHATSAPP_API_KEY: z.string().optional(),
  VETANLY_WHATSAPP_WEBHOOK_SECRET: z.string().optional(),
  // apitxt SMS login codes, used until Vetanly WhatsApp is configured. Unset: no SMS.
  SMS_API_AUTH_KEY: z.string().optional(),
  PLATFORM_BILLING_NAME: z.string().optional(),
  PLATFORM_BILLING_ADDRESS: z.string().optional(),
  PLATFORM_BILLING_GSTIN: z.string().optional(),
  PLATFORM_BILLING_EMAIL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  // A sender on a domain verified in Resend, e.g. "Vetanly <no-reply@yourdomain.com>".
  EMAIL_FROM: z.string().optional(),
  // Public address of this API, for signed file links in local development. Defaults to http://localhost:PORT.
  API_PUBLIC_URL: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export type Env = z.infer<typeof envSchema>;

export const databaseUrl = buildDatabaseUrl(env);

/** One set of Redis options for ioredis and BullMQ alike. */
export const redisConnection = {
  host: env.REDIS_HOST,
  port: Number(env.REDIS_PORT),
  password: env.REDIS_PASSWORD,
};
