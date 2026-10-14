import { Context } from "hono";
import {
  googleLoginSchema,
  refreshTokenSchema,
  sendotpSchema,
  verifyotpSchema,
} from "@/validator/auth.validator";
import {
  createUser,
  getUserByEmail,
  getUserbyPhone,
  getUserById,
  newPlaceholderPhone,
  updateUser,
} from "@/services/user.services";
import { compareHash, hash } from "@/utils/hash";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from "@/services/jwt.services";
import { del, get, incrementWithExpiry, set } from "@/utils/redis";
import { randomInt } from "node:crypto";
import { isGoogleConfigured, verifyGoogleCredential } from "@/services/google.services";
import { getUsersOrganizations } from "@/services/organizations.services";
import { sendResponse } from "@/utils/response";
import { sendOtp } from "@/queue/producer/sendOtp";
import { endSession, isActiveSession, startSession } from "@/services/session.services";

const MAX_OTP_ATTEMPTS = 5;
const MAX_OTP_SENDS_PER_HOUR = 5;

export const refreshAccessToken = async (c: Context): Promise<Response> => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = refreshTokenSchema.safeParse(body);
  if (!parsed.success) {
    return sendResponse(
      c,
      "error",
      parsed.error.issues[0]?.message ?? "Invalid refresh token",
      null,
      400,
    );
  }

  const claims = verifyRefreshToken(parsed.data.refreshToken);
  if (!claims || !(await isActiveSession(claims.id, claims.sid))) {
    return sendResponse(c, "error", "Invalid or expired refresh token", null, 401);
  }

  const user = await getUserById(claims.id);
  if (!user) {
    return sendResponse(c, "error", "User not found", null, 401);
  }

  return sendResponse(
    c,
    "success",
    "Access token refreshed successfully",
    { accessToken: generateAccessToken(user.id, claims.sid) },
  );
};

export const logout = async (c: Context): Promise<Response> => {
  const user = c.get("user");
  await endSession(user.id);
  return sendResponse(c, "success", "Logged out", null);
};

export const sendotp: (c: Context) => Promise<Response> = async (
  c: Context,
) => {
  try {
    const { phone } = sendotpSchema.parse(await c.req.json());
    const mobile = phone.replace(/\D/g, "");
    const sent = await incrementWithExpiry(`otp-send:${mobile}`, 3600);
    if (sent > MAX_OTP_SENDS_PER_HOUR) {
      return sendResponse(c, "error", "Too many OTP requests. Try again later.", null, 429);
    }
    const otp = randomInt(100000, 1000000).toString();
    const hashedOtp = await hash(otp);
    await set(`otp:${mobile}`, hashedOtp, 900);
    await del(`otp-attempts:${mobile}`);
    await sendOtp(mobile, otp);
    return sendResponse(c, "success", "OTP sent successfully", null, 200);
  } catch (error) {
    return sendResponse(c, "error", "Internal server error", null, 500);
  }
};

export const verifyotp: (c: Context) => Promise<Response> = async (
  c: Context,
) => {
  try {
    const { phone, otp } = await verifyotpSchema.parseAsync(await c.req.json());
    const otpKey = `otp:${phone}`;
    const attempts = await incrementWithExpiry(`otp-attempts:${phone}`, 900);
    if (attempts > MAX_OTP_ATTEMPTS) {
      await del(otpKey);
      return sendResponse(c, "error", "Too many attempts. Request a new OTP.", null, 429);
    }
    const storedOtp = await get(otpKey);
    if (!storedOtp || !(await compareHash(otp, storedOtp))) {
      return sendResponse(c, "error", "Incorrect OTP", null, 400);
    }
    await del(otpKey);
    await del(`otp-attempts:${phone}`);
    const existing = await getUserbyPhone(phone);
    const user = existing
      ? existing.phoneVerified
        ? existing
        : ((await updateUser(existing.id, { phoneVerified: true })) ?? existing)
      : await createUser({ fname: "New", lname: "User", phone, phoneVerified: true });
    const userOrganizations = await getUsersOrganizations(user.id);
    const sessionId = await startSession(user.id, c.req.header("user-agent"));
    const accessToken = generateAccessToken(user.id, sessionId);
    const refreshToken = generateRefreshToken(user.id, sessionId);
    return sendResponse(c, "success", "OTP verified successfully", {
      user,
      userOrganizations,
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("OTP verification failed", error);
    return sendResponse(c, "error", "Internal server error", null, 500);
  }
};

export const googleLogin = async (c: Context): Promise<Response> => {
  if (!isGoogleConfigured()) {
    return sendResponse(c, "error", "Google sign-in is not configured", null, 503);
  }
  const parsed = googleLoginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return sendResponse(c, "error", "Google credential is required", null, 400);
  }
  const identity = await verifyGoogleCredential(parsed.data.credential);
  if (!identity) {
    return sendResponse(c, "error", "Invalid Google credential or unverified Google email", null, 401);
  }
  try {
    const existing = await getUserByEmail(identity.email);
    const user = existing
      ? existing.emailVerified
        ? existing
        : ((await updateUser(existing.id, { emailVerified: true })) ?? existing)
      : await createUser({
          fname: (identity.givenName ?? "New").slice(0, 52),
          lname: (identity.familyName ?? "User").slice(0, 52),
          // Placeholder until the user links a real phone; the "g" prefix can never collide with OTP numbers.
          phone: newPlaceholderPhone(),
          email: identity.email,
          emailVerified: true,
        });
    const userOrganizations = await getUsersOrganizations(user.id);
    const sessionId = await startSession(user.id, c.req.header("user-agent"));
    return sendResponse(c, "success", "Signed in with Google", {
      user,
      userOrganizations,
      accessToken: generateAccessToken(user.id, sessionId),
      refreshToken: generateRefreshToken(user.id, sessionId),
    });
  } catch (error) {
    console.error("Google sign-in failed", error);
    return sendResponse(c, "error", "Internal server error", null, 500);
  }
};

export const getLoggedInUserController: (
  c: Context,
) => Promise<Response> = async (c: Context) => {
  try {
    const user = c.get("user");
    if (!user) {
      return sendResponse(c, "error", "User not found", null, 404);
    }
    const userOrganizations = await getUsersOrganizations(user.id);
    return sendResponse(c, "success", "User fetched successfully", {
      user,
      userOrganizations,
    });
  } catch (error) {
    return sendResponse(c, "error", "Internal server error", null, 500);
  }
};