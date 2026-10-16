import { Queue } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import { registerQueue } from "@/queue/lifecycle";
import type { PlatformInvoiceWhatsAppJob } from "@/queue/types";

// Vetanly's own invoices to customers. Organizations' documents use the messaging queue (sendMessage.ts).
export const whatsappQueue = registerQueue(
  new Queue<PlatformInvoiceWhatsAppJob>(queueNames.whatsapp, {
    connection: getQueueConnection(),
  }),
);

export async function enqueuePlatformInvoiceWhatsApp(job: PlatformInvoiceWhatsAppJob) {
  const queued = await whatsappQueue.add("sendPlatformInvoice", job, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  console.info(`[whatsapp] job ${queued.id} queued: platform invoice ${job.invoiceId}`);
}
