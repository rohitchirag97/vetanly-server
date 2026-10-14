import { Worker } from "bullmq";
import { getQueueConnection, queueNames } from "@/queue/config";
import type { AttendanceJob } from "@/queue/types";
import { insertAttendance } from "@/services/attendance.services";

export function createAttendanceWorker() {
  return new Worker<AttendanceJob>(
    queueNames.attendance,
    async (job) => {
      if (job.name !== "recordAttendance") {
        throw new Error(`Unsupported attendance queue job: ${job.name}`);
      }
      console.info(
        `[attendance] job ${job.id} received: ${job.data.source} ${job.data.eventType} for ${job.data.userOrganizationId} (attempt ${job.attemptsMade + 1})`,
      );
      await insertAttendance(job.data);
      console.info(`[attendance] job ${job.id} saved to database`);
    },
    { connection: getQueueConnection(), concurrency: 10 },
  );
}
