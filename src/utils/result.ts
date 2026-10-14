import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { sendResponse } from "@/utils/response";

export type ServiceError = "forbidden" | "not-found" | "conflict" | "invalid" | "payment-required";

export type ServiceFailure = {
  ok: false;
  error: ServiceError;
  message?: string;
};

export type ServiceResult<T> = { ok: true; data: T } | ServiceFailure;

export const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data });

export const fail = (error: ServiceError, message?: string): ServiceFailure => ({
  ok: false,
  error,
  message,
});

const statusByError: Record<ServiceError, ContentfulStatusCode> = {
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  invalid: 400,
  "payment-required": 402,
};

const defaultMessages: Record<ServiceError, string> = {
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  invalid: "Invalid request",
  "payment-required": "Your organization's plan has expired",
};

export const respond = <T>(
  c: Context,
  result: ServiceResult<T>,
  message: string,
  statusCode: ContentfulStatusCode = 200,
): Response =>
  result.ok
    ? sendResponse(c, "success", message, result.data, statusCode)
    : sendResponse(
        c,
        "error",
        result.message ?? defaultMessages[result.error],
        null,
        statusByError[result.error],
      );

export const isUniqueViolation = (error: unknown): boolean => {
  let current: any = error;
  while (current) {
    if (current.code === "23505") return true;
    current = current.cause;
  }
  return false;
};
