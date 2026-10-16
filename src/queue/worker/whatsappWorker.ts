import { Worker, type Job } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import type { PlatformInvoiceWhatsAppJob } from "@/queue/types";
import { VETANLY_TEMPLATES, sendVetanlyWhatsApp } from "@/services/vetanly-whatsapp";
import { buildPlatformInvoicePdf } from "@/services/platform-invoice-pdf";
import { getPlatformInvoiceDelivery, setPlatformInvoiceWhatsAppStatus } from "@/services/platform-billing.services";
import { isR2Configured, uploadPdf } from "@/utils/r2";

const maskPhone = (phone: string) => `${phone.slice(0, 3)}${"*".repeat(Math.max(phone.length - 5, 0))}${phone.slice(-2)}`;

/**
 * Vetanly's own invoices to its customers, sent through Vetanly's WhatsApp service. Organizations'
 * documents (salary slips, NOCs) go through the messaging queue instead (queue/worker/messagingWorker.ts).
 */
export function createWhatsAppWorker() {
  return new Worker<PlatformInvoiceWhatsAppJob>(
    queueNames.whatsapp,
    async (job) => {
      if (job.name !== "sendPlatformInvoice") throw new Error(`Unsupported WhatsApp queue job: ${job.name}`);
      await sendPlatformInvoice(job);
    },
    { connection: getQueueConnection(), concurrency: 5 },
  );
}

async function sendPlatformInvoice(job: Job<PlatformInvoiceWhatsAppJob>) {
  const { invoiceId } = job.data;
  let destination: string | null = null;
  let pdfStorageKey: string | null = null;
  try {
    if (!isR2Configured()) throw new Error("Cloudflare R2 is not configured");
    const delivery = await getPlatformInvoiceDelivery(invoiceId);
    if (!delivery) throw new Error("Invoice no longer exists");
    if (delivery.invoice.status === "void") throw new Error("A void invoice cannot be sent");
    if (!delivery.destination) throw new Error("Customer WhatsApp number is missing");
    const digits = delivery.destination.replace(/\D/g, "");
    if (digits.length < 11 || digits.length > 15) throw new Error("Customer number must include a country code");
    destination = `+${digits}`;

    const pdf = await buildPlatformInvoicePdf(delivery.invoice);
    const filename = `${delivery.invoice.invoiceNumber}.pdf`;
    pdfStorageKey = `platform-invoices/${delivery.invoice.organizationId}/${invoiceId}.pdf`;
    const mediaUrl = await uploadPdf(pdfStorageKey, pdf);
    const formattedTotal = `${delivery.invoice.currencyCode} ${Number(delivery.invoice.totalAmount).toFixed(2)}`;
    const result = await sendVetanlyWhatsApp({
      to: digits,
      template: VETANLY_TEMPLATES.platform_invoice,
      params: [delivery.recipientName, delivery.invoice.invoiceNumber, formattedTotal, delivery.invoice.dueDate || "On receipt"],
      document: { url: mediaUrl, filename },
      reference: `platform-invoice-${invoiceId}-${job.id}`,
    });
    if (result.simulated) throw new Error("Vetanly WhatsApp is not connected on the server yet");
    await setPlatformInvoiceWhatsAppStatus(invoiceId, "sent", destination, null, pdfStorageKey);
    console.info(`[whatsapp] job ${job.id} sent invoice ${delivery.invoice.invoiceNumber} to ${maskPhone(destination)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invoice delivery failed";
    const attempts = Number(job.opts.attempts ?? 1);
    if (job.attemptsMade + 1 >= attempts) {
      await setPlatformInvoiceWhatsAppStatus(invoiceId, "failed", destination, message, pdfStorageKey);
    }
    console.error(`[whatsapp] job ${job.id} invoice delivery failed: ${message}`);
    throw error;
  }
}
