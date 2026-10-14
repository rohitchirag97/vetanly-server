import { Queue } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import { registerQueue } from "@/queue/lifecycle";
import type { AttendanceJob } from "@/queue/types";

export const attendanceQueue = registerQueue(
  new Queue<AttendanceJob>(queueNames.attendance, {
    connection: getQueueConnection(),
  }),
);

/**
 * Queues an attendance punch. Kiosk punches use a job id derived from the kiosk
 * and its event id, so a kiosk retry of the same event is never queued twice.
 */
export async function enqueueAttendance(job: AttendanceJob) {
  const queued = await attendanceQueue.add("recordAttendance", job, {
    jobId: job.kioskId && job.externalEventId ? `${job.kioskId}_${job.externalEventId}` : undefined,
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 24 * 3600, count: 5000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  console.info(`[attendance] job ${queued.id} queued: ${job.source} ${job.eventType}`);
}
