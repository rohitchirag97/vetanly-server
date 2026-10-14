import { Queue } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import { registerQueue } from "@/queue/lifecycle";
import type { LoanNocWhatsAppJob, SalarySlipWhatsAppJob } from "@/queue/types";

// Email jobs carry the same payload as their WhatsApp counterparts; only the channel differs.
export const emailQueue = registerQueue(
  new Queue<SalarySlipWhatsAppJob | LoanNocWhatsAppJob>(queueNames.email, {
    connection: getQueueConnection(),
  }),
);

const jobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export async function enqueueSalarySlipEmail(job: SalarySlipWhatsAppJob) {
  const queued = await emailQueue.add("sendSalarySlip", job, jobOptions);
  console.info(`[email] job ${queued.id} queued: salary slip ${job.itemId}`);
}

export async function enqueueLoanNocEmail(job: LoanNocWhatsAppJob) {
  const queued = await emailQueue.add("sendLoanNoc", job, jobOptions);
  console.info(`[email] job ${queued.id} queued: loan NOC ${job.recoverableId}`);
}
