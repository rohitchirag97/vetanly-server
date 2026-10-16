import { Worker } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import { isSmsOtpConfigured, sendSmsOtp } from "@/services/sms-otp";
import { VETANLY_TEMPLATES, isVetanlyWhatsAppConfigured, sendVetanlyWhatsApp } from "@/services/vetanly-whatsapp";

/**
 * Login codes always go out from Vetanly's own WhatsApp service, never an organization's provider,
 * so every user sees the same trusted sender. Until that service is set up they go by SMS (apitxt);
 * with neither, development prints the code.
 */
export function createOtpWorker() {
  return new Worker(
    queueNames.otp,
    async (job) => {
      if (job.name !== "sendOtp") {
        throw new Error(`Unsupported OTP queue job: ${job.name}`);
      }

      const { phone, otp } = job.data as { phone?: string; otp?: string };
      if (!phone || !otp) {
        throw new Error("OTP job is missing its phone or code");
      }

      if (isVetanlyWhatsAppConfigured()) {
        await sendVetanlyWhatsApp({
          to: phone.replace(/\D/g, ""),
          template: VETANLY_TEMPLATES.otp,
          params: [otp],
          // One code per job: a retry must not send a second message.
          reference: `otp-${job.id}`,
        });
        return;
      }
      if (isSmsOtpConfigured()) {
        await sendSmsOtp(phone, otp);
        return;
      }
      if (process.env.NODE_ENV === "production") {
        throw new Error("Neither Vetanly WhatsApp nor SMS_API_AUTH_KEY is configured, so login codes cannot be sent");
      }
      // Development-only output. Do not log OTPs or phone numbers in production.
      console.log(`Development OTP for ${phone}: ${otp}`);
    },
    { connection: getQueueConnection() },
  );
}
