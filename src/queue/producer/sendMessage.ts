import { Queue } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import { registerQueue } from "@/queue/lifecycle";

/** One job per message_logs row; the worker reads everything else from the log. */
export type MessageJob = { messageLogId: string };

export const messagingQueue = registerQueue(new Queue<MessageJob>(queueNames.messaging, { connection: getQueueConnection() }));

export const MESSAGE_JOB_ATTEMPTS = 3;

export async function enqueueMessage(messageLogId: string) {
  await messagingQueue.add("deliver", { messageLogId }, {
    jobId: messageLogId,
    attempts: MESSAGE_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 24 * 3600, count: 2000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}
