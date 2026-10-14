import { OAuth2Client } from "google-auth-library";

import { env } from "@/utils/env";

const googleClient = new OAuth2Client();

export type GoogleIdentity = { email: string; givenName?: string; familyName?: string };

export const isGoogleConfigured = () => Boolean(env.GOOGLE_CLIENT_ID);

/** Returns the verified Google email behind a sign-in credential, or null when it is invalid or unverified. */
export const verifyGoogleCredential = async (credential: string): Promise<GoogleIdentity | null> => {
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) return null;
    return {
      email: payload.email.toLowerCase(),
      givenName: payload.given_name,
      familyName: payload.family_name,
    };
  } catch {
    return null;
  }
};
