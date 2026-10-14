import type { Context } from "hono";
import { randomInt } from "node:crypto";

import { updateUserSchema } from "@/validator/user.validator";
import { googleLoginSchema, sendotpSchema, verifyotpSchema } from "@/validator/auth.validator";
import { linkGoogleEmail, linkPhone, updateUser } from "@/services/user.services";
import { isGoogleConfigured, verifyGoogleCredential } from "@/services/google.services";
import { sendOtp } from "@/queue/producer/sendOtp";
import { compareHash, hash } from "@/utils/hash";
import { del, get, incrementWithExpiry, set } from "@/utils/redis";
import { firstIssue, readBody } from "@/utils/request";
import { sendResponse } from "@/utils/response";
import { respond } from "@/utils/result";

const MAX_OTP_ATTEMPTS = 5;
const MAX_OTP_SENDS_PER_HOUR = 5;

export const updateMe: (c: Context) => Promise<Response> = async (
  c: Context,
) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ status: "error", message: "Unauthorized" }, 401);
  }
  const parsed = await readBody(c, updateUserSchema);
  if (!parsed.success) {
    return sendResponse(c, "error", firstIssue(parsed.error), null, 400);
  }
  const updatedUser = await updateUser(user.id, parsed.data);
  if (!updatedUser) {
    return c.json({ status: "error", message: "User not found" }, 404);
  }
  return c.json(
    {
      status: "success",
      message: "User updated successfully",
      user: updatedUser,
    },
    200,
  );
};

// The code is bound to both the account and the number, so it cannot be replayed to link a different phone.
const linkOtpKey = (userId: string) => `link-phone-otp:${userId}`;
const linkAttemptsKey = (userId: string) => `link-phone-attempts:${userId}`;

export const sendLinkPhoneOtp = async (c: Context): Promise<Response> => {
  const user = c.get("user");
  const parsed = await readBody(c, sendotpSchema);
  if (!parsed.success) return sendResponse(c, "error", firstIssue(parsed.error), null, 400);
  const { phone } = parsed.data;
  if (user.phone === phone && user.phoneVerified) {
    return sendResponse(c, "error", "This number is already linked to your account", null, 400);
  }
  // Shares the login limit, so linking cannot be used to send more codes to one number.
  const sent = await incrementWithExpiry(`otp-send:${phone}`, 3600);
  if (sent > MAX_OTP_SENDS_PER_HOUR) {
    return sendResponse(c, "error", "Too many OTP requests. Try again later.", null, 429);
  }
  const otp = randomInt(100000, 1000000).toString();
  await set(linkOtpKey(user.id), JSON.stringify({ phone, hash: await hash(otp) }), 900);
  await del(linkAttemptsKey(user.id));
  await sendOtp(phone, otp);
  return sendResponse(c, "success", "OTP sent successfully", null);
};

export const verifyLinkPhoneOtp = async (c: Context): Promise<Response> => {
  const user = c.get("user");
  const parsed = await readBody(c, verifyotpSchema);
  if (!parsed.success) return sendResponse(c, "error", firstIssue(parsed.error), null, 400);
  const { phone, otp } = parsed.data;

  const attempts = await incrementWithExpiry(linkAttemptsKey(user.id), 900);
  if (attempts > MAX_OTP_ATTEMPTS) {
    await del(linkOtpKey(user.id));
    return sendResponse(c, "error", "Too many attempts. Request a new OTP.", null, 429);
  }
  const stored = await get(linkOtpKey(user.id));
  const pending = stored ? (JSON.parse(stored) as { phone: string; hash: string }) : null;
  if (!pending || pending.phone !== phone || !(await compareHash(otp, pending.hash))) {
    return sendResponse(c, "error", "Incorrect OTP", null, 400);
  }
  await del(linkOtpKey(user.id));
  await del(linkAttemptsKey(user.id));
  return respond(c, await linkPhone(user.id, phone), "Phone number linked");
};

export const linkGoogle = async (c: Context): Promise<Response> => {
  if (!isGoogleConfigured()) {
    return sendResponse(c, "error", "Google sign-in is not configured", null, 503);
  }
  const parsed = await readBody(c, googleLoginSchema);
  if (!parsed.success) return sendResponse(c, "error", "Google credential is required", null, 400);
  const identity = await verifyGoogleCredential(parsed.data.credential);
  if (!identity) {
    return sendResponse(c, "error", "Invalid Google credential or unverified Google email", null, 401);
  }
  return respond(c, await linkGoogleEmail(c.get("user").id, identity.email), "Google account linked");
};
