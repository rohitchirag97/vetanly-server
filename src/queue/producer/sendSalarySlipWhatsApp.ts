import { Queue } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import { registerQueue } from "@/queue/lifecycle";
import type { LoanNocWhatsAppJob, PlatformInvoiceWhatsAppJob, SalarySlipWhatsAppJob } from "@/queue/types";

export const whatsappQueue = registerQueue(
  new Queue<SalarySlipWhatsAppJob | LoanNocWhatsAppJob | PlatformInvoiceWhatsAppJob>(queueNames.whatsapp, {
    connection: getQueueConnection(),
  }),
);

export async function enqueueLoanNocWhatsApp(job: LoanNocWhatsAppJob) {
  const queued = await whatsappQueue.add("sendLoanNoc", job, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  console.info(`[whatsapp] job ${queued.id} queued: loan NOC ${job.recoverableId}`);
}

export async function enqueueSalarySlipWhatsApp(job: SalarySlipWhatsAppJob) {
  const queued = await whatsappQueue.add("sendSalarySlip", job, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  console.info(`[whatsapp] job ${queued.id} queued: salary slip ${job.itemId}`);
}

export async function enqueuePlatformInvoiceWhatsApp(job: PlatformInvoiceWhatsAppJob) {
  const queued = await whatsappQueue.add("sendPlatformInvoice", job, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  console.info(`[whatsapp] job ${queued.id} queued: platform invoice ${job.invoiceId}`);
}
