import { UnrecoverableError } from "bullmq";

import { env } from "@/utils/env";

// apitxt Unified OTP API: https://apitxt.com/developer/otp-api
const SEND_OTP_URL = "https://apitxt.com/api/sendOTP";

export const isSmsOtpConfigured = () => Boolean(env.SMS_API_AUTH_KEY);

/**
 * apitxt takes the number with its country code. shortcut: only Indian numbers are sent, since
 * other countries need apitxt's `country` routing; drop this once WhatsApp carries the codes.
 */
export const smsMobile = (phone: string): string | null => {
  const digits = phone.replace(/\D/g, "");
  return /^91[6-9]\d{9}$/.test(digits) ? digits : null;
};

/** Sends a login code by SMS. Throws so the queue retries only when a retry can help. */
export async function sendSmsOtp(phone: string, otp: string, authkey = env.SMS_API_AUTH_KEY ?? "") {
  const mobile = smsMobile(phone);
  if (!mobile) throw new UnrecoverableError("SMS login codes support Indian (+91) mobile numbers only");

  // POST keeps the key and the code out of URLs and access logs.
  const response = await fetch(SEND_OTP_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ authkey, mobile, otp, channel: "sms" }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as { status?: unknown; message?: unknown; code?: unknown } | null;
  if (body?.status === "success") return;

  const reason = `HTTP ${response.status}: ${String(body?.message ?? body?.code ?? "unexpected response")}`;
  // A server error may pass; a refusal (bad key, no balance, rate limit) would fail the same way again.
  if (response.status >= 500) throw new Error(`SMS login code failed, ${reason}`);
  throw new UnrecoverableError(`SMS login code refused, ${reason}`);
}
