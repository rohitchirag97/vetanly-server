import { z } from "zod";

export const sendotpSchema = z.object({
  phone: z.string().regex(/^\d{11,15}$/, "Phone number must include a valid country code"),
});

export const verifyotpSchema = z.object({
  phone: z.string().regex(/^\d{11,15}$/, "Phone number must include a valid country code"),
  otp: z.string().length(6, "OTP must be 6 characters long"),
});

export const googleLoginSchema = z.object({
  credential: z.string().min(20, "Google credential is required"),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export const createUserSchema = z.object({
  fname: z.string().min(1, "First name is required"),
  lname: z.string().min(1, "Last name is required"),
  phone: z.string().min(12, "Phone number must be with country code"),
});
