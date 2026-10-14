import type { Context } from "hono";
import { z } from "zod";
import { sendResponse } from "@/utils/response";

export const readUuid = (value: string | undefined): string | null => {
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const readOrganizationId = (c: Context): string | null =>
  readUuid(c.req.query("organizationId"));

export const badRequest = (c: Context, message: string): Response =>
  sendResponse(c, "error", message, null, 400);

export const missingOrganization = (c: Context): Response =>
  badRequest(c, "A valid organizationId query parameter is required");

export const readBody = async <S extends z.ZodType>(c: Context, schema: S) => {
  const body: unknown = await c.req.json().catch(() => null);
  return schema.safeParse(body);
};

export const firstIssue = (error: z.ZodError): string =>
  error.issues[0]?.message ?? "Invalid request";
