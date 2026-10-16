import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/utils/env";

/**
 * Client for Vetanly's own WhatsApp service, a separate product that wraps Meta's WhatsApp Cloud API.
 * Vetanly talks to it like any third-party provider. The contract it is expected to offer:
 *
 *   POST {URL}/v1/messages   Authorization: Bearer {API_KEY}, Idempotency-Key: {reference}
 *     { to, template, language, params: string[], document?: { url, filename }, reference }
 *     -> 2xx { id }
 *   Status callbacks to Vetanly: POST /webhooks/messaging/vetanly
 *     { id, reference, status: "sent"|"delivered"|"read"|"failed", error? }
 *     header X-Vetanly-Signature: sha256=<hex HMAC-SHA256 of the raw body with WEBHOOK_SECRET>
 *
 * Login OTPs and platform invoices always go through this service, never an organization's provider.
 * Until the URL and key are set, nothing is sent: messages are logged and reported as simulated.
 */

/** Template names registered in Vetanly's WhatsApp service, by purpose. */
export const VETANLY_TEMPLATES = {
  otp: "vetanly_login_otp",
  salary_slip: "vetanly_salary_slip",
  loan_noc: "vetanly_loan_noc",
  platform_invoice: "vetanly_invoice",
  test: "vetanly_test",
} as const;

export const isVetanlyWhatsAppConfigured = () => Boolean(env.VETANLY_WHATSAPP_URL && env.VETANLY_WHATSAPP_API_KEY);

export type VetanlyMessage = {
  to: string; // digits with country code
  template: string;
  language?: string;
  params: string[];
  document?: { url: string; filename: string };
  reference: string;
};

export type SendOutcome = { simulated: true } | { simulated: false; providerMessageId: string | null };

export const sendVetanlyWhatsApp = async (message: VetanlyMessage): Promise<SendOutcome> => {
  if (!isVetanlyWhatsAppConfigured()) {
    // Never log a code: an OTP's params are its secret.
    console.info(`[whatsapp] Vetanly WhatsApp service not configured; would send "${message.template}" (${message.params.length} params${message.document ? ", with PDF" : ""})`);
    return { simulated: true };
  }
  const response = await fetch(`${env.VETANLY_WHATSAPP_URL!.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.VETANLY_WHATSAPP_API_KEY}`,
      "Idempotency-Key": message.reference,
    },
    body: JSON.stringify({ language: "en", ...message }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Vetanly WhatsApp returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  let id: string | null = null;
  try {
    const parsed = JSON.parse(text) as { id?: unknown; data?: { id?: unknown } };
    const raw = parsed.id ?? parsed.data?.id;
    id = raw === undefined || raw === null ? null : String(raw);
  } catch {
    // A 2xx without JSON still means accepted.
  }
  return { simulated: false, providerMessageId: id };
};

/** Checks a status callback's signature; false when no secret is configured. */
export const verifyVetanlySignature = (rawBody: string, header: string | undefined) => {
  const secret = env.VETANLY_WHATSAPP_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim());
  return a.length === b.length && timingSafeEqual(a, b);
};
