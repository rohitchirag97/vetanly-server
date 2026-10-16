import type { ReactElement } from "react";
import { Resend } from "resend";

import { env } from "@/utils/env";

export const isMailConfigured = () => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);

let client: Resend | undefined;

const getClient = () => {
  if (!isMailConfigured()) throw new Error("Email (Resend) is not configured");
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
};

export type PdfEmail = {
  to: string;
  subject: string;
  /** A React Email template. */
  react: ReactElement;
  filename: string;
  pdf: Buffer;
  /** Stable per send request, so a queue retry never delivers the same email twice. */
  idempotencyKey: string;
};

/**
 * Sends one email with a PDF attached and returns Resend's id. Outside production, a missing Resend
 * setup only logs and returns null.
 */
export const sendPdfEmail = async ({ idempotencyKey, ...mail }: PdfEmail): Promise<string | null> => {
  if (!isMailConfigured()) {
    if (process.env.NODE_ENV === "production") throw new Error("Email (Resend) is not configured");
    console.warn(`[email] Resend not configured; would send "${mail.subject}" (${mail.pdf.length} byte PDF)`);
    return null;
  }
  const { data, error } = await getClient().emails.send(
    {
      from: env.EMAIL_FROM!,
      to: mail.to,
      subject: mail.subject,
      react: mail.react,
      attachments: [{ filename: mail.filename, content: mail.pdf, contentType: "application/pdf" }],
    },
    { idempotencyKey },
  );
  if (error) throw new Error(`Resend rejected the email: ${error.message}`);
  return data?.id ?? null;
};
