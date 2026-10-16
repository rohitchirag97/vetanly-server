import { UnrecoverableError, Worker } from "bullmq";

import { getQueueConnection, queueNames } from "@/queue/config";
import { MESSAGE_JOB_ATTEMPTS, type MessageJob } from "@/queue/producer/sendMessage";
import { deliverMessage, failMessage } from "@/services/messaging-delivery";

/**
 * Organizations' documents by email or WhatsApp (salary slips, NOCs). On the last failed attempt, or a
 * failure that cannot be fixed by retrying, the message is marked failed and its charge refunded.
 */
export function createMessagingWorker() {
  return new Worker<MessageJob>(
    queueNames.messaging,
    async (job) => {
      try {
        await deliverMessage(job.data.messageLogId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Delivery failed";
        const lastAttempt = error instanceof UnrecoverableError || job.attemptsMade + 1 >= Number(job.opts.attempts ?? MESSAGE_JOB_ATTEMPTS);
        if (lastAttempt) await failMessage(job.data.messageLogId, message);
        console.error(`[messaging] message ${job.data.messageLogId} attempt ${job.attemptsMade + 1} failed: ${message}`);
        throw error;
      }
    },
    { connection: getQueueConnection(), concurrency: 5 },
  );
}
