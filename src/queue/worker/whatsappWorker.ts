import { Worker, type Job } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import type { LoanNocWhatsAppJob, PlatformInvoiceWhatsAppJob, SalarySlipWhatsAppJob } from "@/queue/types";
import { loadLoanNoc } from "@/services/loan-noc.services";
import { buildLoanNocPdf } from "@/services/loan-noc-pdf";
import { loadSlipDelivery } from "@/services/payroll.services";
import { buildSalarySlipPdf, salarySlipFilename } from "@/services/salary-slip-pdf";
import { buildPlatformInvoicePdf } from "@/services/platform-invoice-pdf";
import { getPlatformInvoiceDelivery, setPlatformInvoiceWhatsAppStatus } from "@/services/platform-billing.services";
import { env } from "@/utils/env";
import { isR2Configured, uploadPdf } from "@/utils/r2";

const maskPhone = (phone: string) => `${phone.slice(0, 3)}${"*".repeat(Math.max(phone.length - 5, 0))}${phone.slice(-2)}`;

export function createWhatsAppWorker() {
  return new Worker<SalarySlipWhatsAppJob | LoanNocWhatsAppJob | PlatformInvoiceWhatsAppJob>(
    queueNames.whatsapp,
    async (job) => {
      if (job.name === "sendLoanNoc") {
        const data = job.data as LoanNocWhatsAppJob;
        const loaded = await loadLoanNoc(data.organizationId, data.recoverableId);
        if (!loaded.ok) throw new Error(loaded.message ?? "Loan NOC is no longer available");
        const pdf = await buildLoanNocPdf(loaded.data.noc);
        let pdfUrl = "(R2 not configured - PDF generated but not uploaded)";
        if (isR2Configured()) {
          pdfUrl = await uploadPdf(`loan-noc/${data.organizationId}/${data.recoverableId}.pdf`, pdf);
        } else if (process.env.NODE_ENV === "production") {
          throw new Error("Cloudflare R2 is not configured");
        }
        // TODO: replace with the AiSensy campaign API call once credentials are configured.
        console.info(
          `[whatsapp] job ${job.id} would send to ${maskPhone(loaded.data.phone)} (AiSensy not connected yet):`,
          { template: "loan_noc", reference: loaded.data.noc.reference, pdfBytes: pdf.length, uploaded: isR2Configured() },
        );
        void pdfUrl;
        return;
      }
      if (job.name === "sendPlatformInvoice") {
        await sendPlatformInvoice(job as Job<PlatformInvoiceWhatsAppJob>);
        return;
      }
      if (job.name !== "sendSalarySlip") {
        throw new Error(`Unsupported WhatsApp queue job: ${job.name}`);
      }
      const slipJob = job as Job<SalarySlipWhatsAppJob>;
      return sendSalarySlip(slipJob);
    },
    { connection: getQueueConnection(), concurrency: 5 },
  );
}

async function sendPlatformInvoice(job: Job<PlatformInvoiceWhatsAppJob>) {
  const { invoiceId } = job.data;
  let destination: string | null = null;
  let pdfStorageKey: string | null = null;
  try {
    if (!env.AISENSY_API_KEY || !env.AISENSY_INVOICE_CAMPAIGN_NAME) {
      throw new Error("AiSensy API key and live invoice campaign are required");
    }
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
    const response = await fetch("https://backend.aisensy.com/campaign/t1/api/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        apiKey: env.AISENSY_API_KEY,
        campaignName: env.AISENSY_INVOICE_CAMPAIGN_NAME,
        destination,
        userName: delivery.recipientName,
        source: "HazriPro platform invoices",
        media: { url: mediaUrl, filename },
        templateParams: [delivery.invoice.invoiceNumber, formattedTotal, delivery.invoice.dueDate || "On receipt"],
      }),
    });
    if (!response.ok) {
      throw new Error(`AiSensy returned HTTP ${response.status}`);
    }
    const result = await response.json().catch(() => null) as { status?: number | string; success?: boolean } | null;
    const numericStatus = typeof result?.status === "string" && /^\d+$/.test(result.status)
      ? Number(result.status)
      : result?.status;
    if (result?.success === false || (typeof numericStatus === "number" && numericStatus !== 200)) {
      throw new Error("AiSensy did not accept the invoice campaign request");
    }
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

async function sendSalarySlip(job: Job<SalarySlipWhatsAppJob>) {
      console.info(
        `[whatsapp] job ${job.id} received: salary slip ${job.data.itemId} (attempt ${job.attemptsMade + 1})`,
      );

      const delivery = await loadSlipDelivery(job.data.organizationId, job.data.itemId);
      if (!delivery) throw new Error("Salary slip no longer exists");

      const filename = salarySlipFilename(delivery.pdf);
      const pdf = await buildSalarySlipPdf(delivery.pdf);
      console.info(`[whatsapp] job ${job.id} generated PDF (${pdf.length} bytes)`);

      let pdfUrl: string;
      if (isR2Configured()) {
        pdfUrl = await uploadPdf(
          `salary-slips/${job.data.organizationId}/${job.data.itemId}.pdf`,
          pdf,
        );
        console.info(`[whatsapp] job ${job.id} uploaded PDF to Cloudflare R2`);
      } else if (process.env.NODE_ENV === "production") {
        throw new Error("Cloudflare R2 is not configured");
      } else {
        pdfUrl = "(R2 not configured - PDF generated but not uploaded)";
        console.warn(`[whatsapp] job ${job.id} skipped R2 upload: set the R2_* variables to enable it`);
      }

      // TODO: replace with the AiSensy campaign API call once credentials are configured.
      // AiSensy takes the PDF as a document media URL (mediaUrl) on the campaign payload.
      console.info(
        `[whatsapp] job ${job.id} would send to ${maskPhone(delivery.phone)} (AiSensy not connected yet):`,
        {
          template: "salary_slip",
          templateParams: delivery.params,
          media: { filename },
        },
      );
}
